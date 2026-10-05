import * as git from './git';
import { StageEditTarget } from './uris';

export type Editability =
	| { editable: true; entry: git.IndexEntry; content: Buffer }
	| { editable: false; reason: string };

const SUBMODULE_MODE = '160000';

/** Scans the leading bytes for a NUL, the same heuristic git uses to call a blob binary. */
function looksBinary(content: Buffer): boolean {
	return content.subarray(0, 8000).includes(0);
}

/**
 * Decides whether the staged side of this file can be edited, and why not when it can't.
 *
 * Everything we need comes out of the index entry, which is also what tells modifications and
 * additions (one stage-0 entry) apart from the cases we deliberately leave to the stock
 * read-only diff. A rename needs no special handling: git computes rename detection at diff
 * time, so the new path simply has an ordinary index entry.
 */
export async function checkEditability(target: StageEditTarget): Promise<Editability> {
	const entries = await git.getIndexEntries(target.repositoryRoot, target.relativePath);

	if (entries.length === 0) {
		return {
			editable: false,
			reason: 'this path has no entry in the index — a staged deletion has nothing to edit',
		};
	}

	if (entries.length > 1 || entries[0].stage !== 0) {
		return {
			editable: false,
			reason: 'this path is unmerged; resolve the conflict before editing the staged copy',
		};
	}

	const [entry] = entries;

	if (entry.mode === SUBMODULE_MODE) {
		return { editable: false, reason: 'this path is a submodule' };
	}

	const content = await git.readBlob(target.repositoryRoot, entry.objectId);
	if (looksBinary(content)) {
		return { editable: false, reason: 'the staged content is binary' };
	}

	return { editable: true, entry, content };
}
