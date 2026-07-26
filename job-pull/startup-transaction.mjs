// Startup mode deliberately reuses the bounded fixture transaction seam. It is
// re-exported here so startup tests and callers do not need a live gateway.
export { createFakeTransactionalGateway } from './normal-transaction.mjs';

