import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export const BOARD_ROTATION_STATE_SCHEMA = 1;
export const DEFAULT_BOARD_ROTATION_STATE_PATH = '.local/launchpad-crawler/board-rotation-state.json';

export function emptyBoardRotationState() {
  return { schemaVersion: BOARD_ROTATION_STATE_SCHEMA, updatedAt: null, cursor: 0, providerCursors: {}, lastAttemptByBoard: {} };
}

export function loadBoardRotationState(file = DEFAULT_BOARD_ROTATION_STATE_PATH) {
  if (!existsSync(file)) return emptyBoardRotationState();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    const state = emptyBoardRotationState();
    if (raw && typeof raw === 'object') {
      if (Number.isFinite(raw.cursor)) state.cursor = raw.cursor;
      if (raw.providerCursors && typeof raw.providerCursors === 'object') state.providerCursors = { ...raw.providerCursors };
      if (raw.rankGroupCursors && typeof raw.rankGroupCursors === 'object') state.rankGroupCursors = { ...raw.rankGroupCursors };
      if (raw.lastAttemptByBoard && typeof raw.lastAttemptByBoard === 'object') state.lastAttemptByBoard = { ...raw.lastAttemptByBoard };
      if (raw.boardPlanState && typeof raw.boardPlanState === 'object') state.boardPlanState = { ...raw.boardPlanState };
      state.updatedAt = raw.updatedAt || null;
    }
    return state;
  } catch {
    return emptyBoardRotationState();
  }
}

export function saveBoardRotationState(file = DEFAULT_BOARD_ROTATION_STATE_PATH, state, nowIso) {
  const out = { schemaVersion: BOARD_ROTATION_STATE_SCHEMA, updatedAt: nowIso, cursor: state?.cursor ?? 0, providerCursors: state?.providerCursors ?? {}, lastAttemptByBoard: state?.lastAttemptByBoard ?? {} };
  if (state?.rankGroupCursors && Object.keys(state.rankGroupCursors).length) out.rankGroupCursors = state.rankGroupCursors;
  if (state?.boardPlanState && Object.keys(state.boardPlanState).length) out.boardPlanState = state.boardPlanState;
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(out, null, 2) + '\n', 'utf-8');
    renameSync(temporary, file);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
  return out;
}
