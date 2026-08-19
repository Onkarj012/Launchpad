// Remote mode uses the same bounded in-memory transaction semantics as Issue03,
// but exposes its own import surface so callers cannot accidentally select a
// live Notion gateway.
export { createFakeTransactionalGateway } from './normal-transaction.mjs';
