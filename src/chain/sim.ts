// A tiny local NEAR-like runtime that enforces the access-key rules that
// matter for this project. It is NOT nearcore; it mirrors the documented
// semantics (docs.near.org/protocol/accounts-contracts/access-keys):
//
//  * Function-call keys can only sign FunctionCall actions, only to their
//    receiver_id, only for listed method_names (empty list = any method),
//    and cannot attach NEAR (deposit must be 0).
//  * Their gas allowance is charged per transaction; when it runs out the key
//    can no longer sign (NotEnoughAllowance). Adding NEAR to the account does
//    not help, because the allowance belongs to the key.
//  * Only full-access keys can Transfer, AddKey, DeleteKey, DeployContract.

import { sha256 } from "../util.ts";
import { verifySig, type KeyPair } from "../keys.ts";

export type Permission =
  | { kind: "FullAccess" }
  | { kind: "FunctionCall"; receiverId: string; methodNames: string[]; allowance: bigint | null };

export interface AccessKey { permission: Permission; nonce: number }

export type Action =
  | { type: "Transfer"; deposit: bigint }
  | { type: "FunctionCall"; methodName: string; args: Record<string, unknown>; gas: bigint; deposit: bigint }
  | { type: "AddKey"; publicKeyHex: string; permission: Permission }
  | { type: "DeleteKey"; publicKeyHex: string }
  | { type: "DeployContract"; code: string };

export interface Transaction { signerId: string; publicKeyHex: string; receiverId: string; nonce: number; actions: Action[] }
export interface SignedTransaction { tx: Transaction; signature: string }

export interface CallContext {
  predecessor: string;
  currentAccount: string;
  blockTimestampMs: number;
  attachedDeposit: bigint;
  log: (s: string) => void;
  transfer: (to: string, amount: bigint) => void;
}

export interface SimContract {
  call(method: string, args: Record<string, unknown>, ctx: CallContext): unknown;
  view(method: string, args: Record<string, unknown>, ctx: Pick<CallContext, "blockTimestampMs" | "currentAccount">): unknown;
}

export interface Outcome {
  hash: string;
  signerId: string;
  receiverId: string;
  keyKind: Permission["kind"] | "unknown";
  actions: string[];
  status: "SuccessValue" | "Failure";
  error?: string;
  logs: string[];
  transfers: { to: string; amount: bigint }[];
}

interface Account { balance: bigint; keys: Map<string, AccessKey>; contract?: SimContract }

/** 1 Tgas = 0.0001 NEAR at 100 Mgas/yocto price used here (illustrative). */
export const GAS_PRICE_YOCTO = 100_000_000n;
export const TGAS = 10n ** 12n;

export class SimChain {
  private accounts = new Map<string, Account>();
  readonly outcomes: Outcome[] = [];
  constructor(public nowMs: number) {}

  createAccount(id: string, balance: bigint) {
    if (this.accounts.has(id)) throw new Error(`account exists: ${id}`);
    this.accounts.set(id, { balance, keys: new Map() });
  }
  addKeyGenesis(id: string, publicKeyHex: string, permission: Permission) {
    this.acc(id).keys.set(publicKeyHex, { permission, nonce: 0 });
  }
  deploy(id: string, c: SimContract) { this.acc(id).contract = c; }
  balance(id: string) { return this.acc(id).balance; }
  accessKey(id: string, pk: string) { return this.acc(id).keys.get(pk); }
  keyKinds(id: string) { return [...this.acc(id).keys.values()].map((k) => k.permission.kind); }
  has(id: string) { return this.accounts.has(id); }

  view(id: string, method: string, args: Record<string, unknown> = {}) {
    const c = this.acc(id).contract;
    if (!c) throw new Error(`${id} has no contract`);
    return c.view(method, args, { blockTimestampMs: this.nowMs, currentAccount: id });
  }

  /** Build + sign a transaction with the given key (what a wallet would do). */
  signTx(signerId: string, key: KeyPair, receiverId: string, actions: Action[]): SignedTransaction {
    const ak = this.acc(signerId).keys.get(key.publicKeyHex);
    const tx: Transaction = { signerId, publicKeyHex: key.publicKeyHex, receiverId, nonce: (ak?.nonce ?? 0) + 1, actions };
    return { tx, signature: key.sign(sha256(serialize(tx))) };
  }

  send(stx: SignedTransaction): Outcome {
    const { tx } = stx;
    const out: Outcome = {
      hash: sha256(serialize(tx) + stx.signature).slice(0, 16),
      signerId: tx.signerId, receiverId: tx.receiverId, keyKind: "unknown",
      actions: tx.actions.map(describe), status: "Failure", logs: [], transfers: [],
    };
    const fail = (e: string) => { out.error = e; this.outcomes.push(out); return out; };

    const signer = this.accounts.get(tx.signerId);
    if (!signer) return fail("InvalidTxError: SignerDoesNotExist");
    const ak = signer.keys.get(tx.publicKeyHex);
    if (!ak) return fail("InvalidTxError: InvalidAccessKeyError::AccessKeyNotFound");
    out.keyKind = ak.permission.kind;
    if (!verifySig(tx.publicKeyHex, sha256(serialize(tx)), stx.signature)) return fail("InvalidTxError: InvalidSignature");
    if (tx.nonce <= ak.nonce) return fail("InvalidTxError: InvalidNonce");

    const gas = tx.actions.reduce((g, a) => g + (a.type === "FunctionCall" ? a.gas : 0n), 0n);
    const gasCost = gas * GAS_PRICE_YOCTO;

    if (ak.permission.kind === "FunctionCall") {
      const p = ak.permission;
      if (tx.actions.some((a) => a.type !== "FunctionCall"))
        return fail("InvalidTxError: InvalidAccessKeyError::RequiresFullAccess (function-call key cannot sign Transfer/AddKey/DeleteKey/Deploy)");
      if (tx.receiverId !== p.receiverId)
        return fail(`InvalidTxError: InvalidAccessKeyError::ReceiverMismatch (key is scoped to ${p.receiverId}, tx targets ${tx.receiverId})`);
      for (const a of tx.actions as Extract<Action, { type: "FunctionCall" }>[]) {
        if (a.deposit !== 0n) return fail("InvalidTxError: InvalidAccessKeyError::DepositWithFunctionCall (function-call key cannot attach NEAR)");
        if (p.methodNames.length && !p.methodNames.includes(a.methodName))
          return fail(`InvalidTxError: InvalidAccessKeyError::MethodNameMismatch (${a.methodName})`);
      }
      if (p.allowance !== null) {
        if (p.allowance < gasCost) return fail(`InvalidTxError: InvalidAccessKeyError::NotEnoughAllowance (allowance ${p.allowance} < cost ${gasCost})`);
        p.allowance -= gasCost;
      }
    }
    const deposits = tx.actions.reduce((s, a) => s + ("deposit" in a ? a.deposit : 0n), 0n);
    if (signer.balance < gasCost + deposits) return fail("InvalidTxError: NotEnoughBalance");
    ak.nonce = tx.nonce;
    signer.balance -= gasCost;

    // Execute actions (all-or-nothing for this simplified runtime).
    const pendingTransfers: { to: string; amount: bigint; from: string }[] = [];
    try {
      for (const a of tx.actions) {
        switch (a.type) {
          case "Transfer":
            pendingTransfers.push({ from: tx.signerId, to: tx.receiverId, amount: a.deposit });
            break;
          case "AddKey":
            if (tx.receiverId !== tx.signerId) throw new Error("ActionError: AddKey must target signer");
            signer.keys.set(a.publicKeyHex, { permission: a.permission, nonce: 0 });
            break;
          case "DeleteKey":
            signer.keys.delete(a.publicKeyHex);
            break;
          case "DeployContract":
            throw new Error("ActionError: deploy not supported in simulator");
          case "FunctionCall": {
            const target = this.accounts.get(tx.receiverId);
            if (!target?.contract) throw new Error("ActionError: CodeDoesNotExist");
            if (a.deposit > 0n) pendingTransfers.push({ from: tx.signerId, to: tx.receiverId, amount: a.deposit });
            target.contract.call(a.methodName, a.args, {
              predecessor: tx.signerId,
              currentAccount: tx.receiverId,
              blockTimestampMs: this.nowMs,
              attachedDeposit: a.deposit,
              log: (s) => out.logs.push(s),
              transfer: (to, amount) => pendingTransfers.push({ from: tx.receiverId, to, amount }),
            });
          }
        }
      }
    } catch (e) {
      const m = (e as Error).message;
      return fail(m.startsWith("ActionError") ? m : `ActionError: FunctionCallError(ExecutionError("Smart contract panicked: ${m}"))`);
    }
    for (const t of pendingTransfers) {
      const from = this.acc(t.from);
      if (from.balance < t.amount) return fail("ActionError: LackBalanceForTransfer");
      from.balance -= t.amount;
      if (!this.accounts.has(t.to)) this.createAccount(t.to, 0n);
      this.acc(t.to).balance += t.amount;
      out.transfers.push({ to: t.to, amount: t.amount });
    }
    out.status = "SuccessValue";
    this.outcomes.push(out);
    return out;
  }

  private acc(id: string): Account {
    const a = this.accounts.get(id);
    if (!a) throw new Error(`unknown account ${id}`);
    return a;
  }
}

const serialize = (tx: Transaction) => JSON.stringify(tx, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const describe = (a: Action) => (a.type === "FunctionCall" ? `FunctionCall(${a.methodName})` : a.type);
