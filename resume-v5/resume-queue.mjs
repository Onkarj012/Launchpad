import { readMakeResumeQueue } from './queue-reader.mjs';
import { verifyResumeArtifact } from './artifact-state.mjs';

function updater(gateway) {
  if (typeof gateway?.updatePage !== 'function') throw new Error('v5 resume queue requires gateway.updatePage');
  return gateway.updatePage.bind(gateway);
}

async function updateState(updatePage, applicationId, resumeState) {
  await updatePage('applications', applicationId, { resumeState });
}

/**
 * Build only the rows returned by the direct v5 Make Resume query. The build
 * callback is the existing local resume pipeline adapter; this module never
 * compiles or changes either checkbox.
 */
export async function processMakeResumeQueue({ gateway, build, verifyPdf, now = () => Date.now(), pageSize = 100 } = {}) {
  if (typeof build !== 'function') throw new Error('a local resume build adapter is required');
  const updatePage = updater(gateway);
  const queue = await readMakeResumeQueue({ gateway, pageSize });
  const results = [];

  for (const application of queue) {
    const result = { applicationId: application.id, role: application.role, company: application.companyName ?? application.company, previousState: application.resumeState };
    try {
      await updateState(updatePage, application.id, 'Building');
      const artifact = await build(application);
      const verification = await verifyResumeArtifact({ application, artifact, verifyPdf, now });
      await updateState(updatePage, application.id, verification.state);
      results.push({ ...result, state: verification.state, artifact: verification.ok ? verification : artifact, verification });
    } catch (error) {
      try { await updateState(updatePage, application.id, 'Failed'); } catch (stateError) { error.stateError = stateError; }
      results.push({ ...result, state: 'Failed', error: { code: error.code ?? 'RESUME_BUILD_FAILED', message: error.message }, stateError: error.stateError ? { message: error.stateError.message } : null });
    }
  }

  const failed = results.filter((result) => result.state === 'Failed' || result.state === 'Stale');
  return {
    status: failed.length ? (failed.length === results.length && results.length ? 'failed' : 'partial') : 'ready',
    selected: queue.length,
    results,
  };
}

