import * as vscode from 'vscode';

/**
 * The slice of the built-in Git extension's API we use. Its real `git.d.ts` is not published
 * on npm, and we only need two things from it: a nudge to re-read status after we change the
 * index, and a signal that someone else changed it.
 */
interface Repository {
	readonly rootUri: vscode.Uri;
	readonly state: { readonly onDidChange: vscode.Event<void> };
	status(): Promise<void>;
}

interface API {
	readonly repositories: Repository[];
	readonly onDidOpenRepository: vscode.Event<Repository>;
	readonly onDidCloseRepository: vscode.Event<Repository>;
	getRepository(uri: vscode.Uri): Repository | null;
}

interface GitExtensionExports {
	getAPI(version: 1): API;
}

let api: API | undefined;

export async function getGitApi(): Promise<API | undefined> {
	if (api) {
		return api;
	}
	const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
	if (!extension) {
		return undefined;
	}
	const exports = extension.isActive ? extension.exports : await extension.activate();
	api = exports.getAPI(1);
	return api;
}

/** Asks the Git extension to re-read status for the repository containing `repositoryRoot`. */
export async function refreshRepository(repositoryRoot: string): Promise<void> {
	try {
		const gitApi = await getGitApi();
		const repository = gitApi?.getRepository(vscode.Uri.file(repositoryRoot));
		await repository?.status();
	} catch {
		// A refresh is a convenience; the Git extension also watches .git itself.
	}
}

/** Fires whenever any open repository's status changes, including index writes from elsewhere. */
export async function onAnyRepositoryStateChange(
	listener: () => void,
	disposables: vscode.Disposable[],
): Promise<void> {
	const gitApi = await getGitApi();
	if (!gitApi) {
		return;
	}

	const perRepository = new Map<string, vscode.Disposable>();

	const track = (repository: Repository) => {
		const key = repository.rootUri.toString();
		perRepository.get(key)?.dispose();
		perRepository.set(key, repository.state.onDidChange(listener));
	};

	gitApi.repositories.forEach(track);
	disposables.push(gitApi.onDidOpenRepository(track));
	disposables.push(
		gitApi.onDidCloseRepository((repository) => {
			const key = repository.rootUri.toString();
			perRepository.get(key)?.dispose();
			perRepository.delete(key);
		}),
	);
	disposables.push(
		new vscode.Disposable(() => {
			perRepository.forEach((disposable) => disposable.dispose());
			perRepository.clear();
		}),
	);
}
