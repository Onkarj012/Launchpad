import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { verifyApplicationEvidencePacket } from './application-evidence.mjs';
import { structuredError } from '../notion-v5/transaction.mjs';

const DELIVERY_RECEIPT_VERSION = 'LaunchpadApplicationsDeliveryV1';

export class ApplicationDeliveryError extends Error {
  constructor(message, code = 'APPLICATION_DELIVERY_FAILED', details = null) {
    super(message);
    this.name = 'ApplicationDeliveryError';
    this.code = code;
    this.details = details;
  }
}

function readReceipt(receiptPath) {
  if (!receiptPath || !existsSync(receiptPath)) return null;
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    return receipt?.version === DELIVERY_RECEIPT_VERSION ? receipt : null;
  } catch {
    return null;
  }
}

function writeReceipt(receiptPath, receipt) {
  if (!receiptPath) throw new ApplicationDeliveryError('local recovery receipt path is required', 'RECEIPT_PATH_REQUIRED');
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  const temporary = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, receiptPath);
}

function legacyTarget(gateway) {
  return /(?:^|[^0-9])v[34](?:$|[^0-9])/i.test(String(gateway?.version ?? gateway?.targetVersion ?? gateway?.target ?? ''));
}

function validateOperations(operations) {
  if (!Array.isArray(operations) || !operations.length) throw new ApplicationDeliveryError('at least one application operation is required', 'OPERATIONS_REQUIRED');
  for (const operation of operations) {
    if (operation?.resource !== 'application' || operation?.operation !== 'create') throw new ApplicationDeliveryError('delivery accepts only Applications v5 create operations', 'OPERATION_INVALID');
    const verification = verifyApplicationEvidencePacket(operation.payload?.evidencePacket);
    if (!verification.valid) throw new ApplicationDeliveryError(verification.errors.join('; '), 'APPLICATION_EVIDENCE_INVALID', verification.errors);
  }
  return operations;
}

function deliveryKey(operations) {
  const identities = operations.map((operation) => {
    const packet = operation.payload.evidencePacket;
    return `${packet.identity}:${packet.jdSha256}`;
  }).sort();
  return `applications-delivery:${createHash('sha256').update(JSON.stringify(identities)).digest('hex')}`;
}

function committed(result) {
  return result === true || result?.status === 'committed' || result?.committed === true;
}

export async function deliverApplicationsV5({
  operations = [],
  gateway,
  receiptPath,
  liveWriteAuthorized = false,
  externalCommitPolicy = 'required',
  commitLocal,
  markSurfaced,
} = {}) {
  if (liveWriteAuthorized !== true) {
    return { status: 'disabled', reason: 'LIVE_WRITE_AUTHORIZATION_REQUIRED', externalWrites: 0, surfaced: false, legacyFallback: false };
  }
  if (externalCommitPolicy !== 'required') throw new ApplicationDeliveryError('enabled delivery requires the required external commit policy', 'EXTERNAL_COMMIT_POLICY_INVALID');
  if (!gateway || gateway.live !== true || typeof gateway.runTransaction !== 'function') throw new ApplicationDeliveryError('explicit live Applications v5 gateway is required', 'LIVE_V5_GATEWAY_REQUIRED');
  if (legacyTarget(gateway)) throw new ApplicationDeliveryError('legacy v3/v4 delivery targets are refused', 'LEGACY_TARGET_REFUSED');
  if (typeof commitLocal !== 'function' || typeof markSurfaced !== 'function') throw new ApplicationDeliveryError('local commit and surfaced-state callbacks are required', 'COMMIT_CALLBACK_REQUIRED');

  const previous = readReceipt(receiptPath);
  if (previous?.state === 'committed') {
    return { status: 'committed', transactionKey: previous.transactionKey, externalWrites: 0, surfaced: true, recovered: true, legacyFallback: false };
  }
  const effectiveOperations = validateOperations(operations.length ? operations : previous?.operations);
  const transactionKey = previous?.transactionKey ?? deliveryKey(effectiveOperations);
  let receipt = previous ?? {
    version: DELIVERY_RECEIPT_VERSION,
    transactionKey,
    state: 'local-pending',
    externalCommitPolicy,
    operations: effectiveOperations,
    local: null,
    external: null,
    surfaced: null,
    error: null,
  };
  writeReceipt(receiptPath, receipt);

  try {
    if (!committed(receipt.local)) {
      const local = await commitLocal({ operations: effectiveOperations, transactionKey, recovery: Boolean(previous) });
      if (!committed(local)) throw new ApplicationDeliveryError('local application receipt did not commit', 'LOCAL_COMMIT_INCOMPLETE', local);
      receipt = { ...receipt, state: 'external-pending', local, error: null };
      writeReceipt(receiptPath, receipt);
    }

    const external = await gateway.runTransaction({
      key: transactionKey,
      target: 'companies+applications',
      work: async ({ checkpoint }) => {
        const writes = [];
        for (const operation of effectiveOperations) {
          if (typeof gateway.writeApplication !== 'function') throw new ApplicationDeliveryError('v5 gateway.writeApplication is required', 'GATEWAY_WRITE_REQUIRED');
          const result = await gateway.writeApplication({
            application: operation.payload,
            company: operation.company ?? {},
            reconcile: true,
          });
          if (result?.relationVerified !== true) throw new ApplicationDeliveryError('application-company relation was not verified', 'RELATION_VERIFICATION_FAILED');
          writes.push({
            identity: operation.payload.evidencePacket.identity,
            applicationPageId: result.page?.id ?? null,
            companyPageId: result.company?.id ?? null,
            reconciled: result.reconciled === true,
          });
          await checkpoint({ applicationWrites: writes });
        }
        return { writes };
      },
    });
    if (external?.status !== 'committed') {
      receipt = { ...receipt, state: 'external-pending', external, error: { code: 'EXTERNAL_COMMIT_INCOMPLETE', message: 'external transaction did not commit' } };
      writeReceipt(receiptPath, receipt);
      return { status: 'recovery-required', transactionKey, externalWrites: 0, surfaced: false, recoveryReceipt: receiptPath, legacyFallback: false };
    }
    receipt = { ...receipt, state: 'surface-pending', external, error: null };
    writeReceipt(receiptPath, receipt);

    const surfaced = await markSurfaced({ operations: effectiveOperations, transactionKey, local: receipt.local, external });
    if (!committed(surfaced)) throw new ApplicationDeliveryError('surfaced state did not commit', 'SURFACED_COMMIT_INCOMPLETE', surfaced);
    receipt = { ...receipt, state: 'committed', surfaced, error: null };
    writeReceipt(receiptPath, receipt);
    return {
      status: 'committed',
      transactionKey,
      externalWrites: effectiveOperations.length,
      surfaced: true,
      recovered: Boolean(previous),
      recoveryReceipt: receiptPath,
      legacyFallback: false,
    };
  } catch (error) {
    receipt = { ...receipt, state: receipt.state === 'local-pending' ? 'local-pending' : 'external-pending', error: structuredError(error) };
    writeReceipt(receiptPath, receipt);
    return {
      status: 'recovery-required',
      transactionKey,
      externalWrites: 0,
      surfaced: false,
      recoveryReceipt: receiptPath,
      error: receipt.error,
      legacyFallback: false,
    };
  }
}
