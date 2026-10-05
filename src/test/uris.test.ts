import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
	SCHEME,
	gitUriFsPath,
	isIndexUri,
	parseStageEditUri,
	toHeadUri,
	toStageEditUri,
} from '../uris';
import { describeStagedTab } from '../stagedDiff';

/** Mirrors the Git extension's toGitUri. */
function gitUri(fsPath: string, ref: string): vscode.Uri {
	return vscode.Uri.file(fsPath).with({
		scheme: 'git',
		query: JSON.stringify({ path: fsPath, ref }),
	});
}

function fakeTab(input: unknown): vscode.Tab {
	return { input } as vscode.Tab;
}

suite('URI handling', () => {
	test('recognises the index ref and nothing else', () => {
		assert.equal(isIndexUri(gitUri('/repo/a.txt', '')), true);
		assert.equal(isIndexUri(gitUri('/repo/a.txt', 'HEAD')), false);
		assert.equal(isIndexUri(gitUri('/repo/a.txt', 'abc1234')), false);
		// `~` is the left side of a *working-tree* diff; treating it as the index would make
		// every unstaged diff look staged.
		assert.equal(isIndexUri(gitUri('/repo/a.txt', '~')), false);
		assert.equal(isIndexUri(vscode.Uri.file('/repo/a.txt')), false);
	});

	test('ignores malformed git URIs instead of throwing', () => {
		const broken = vscode.Uri.file('/repo/a.txt').with({ scheme: 'git', query: 'not json' });
		assert.equal(isIndexUri(broken), false);
		assert.equal(gitUriFsPath(broken), undefined);
	});

	test('round-trips a stage-edit URI', () => {
		const target = { repositoryRoot: '/repo', relativePath: 'src/a.txt' };
		const uri = toStageEditUri(target);

		assert.equal(uri.scheme, SCHEME);
		assert.ok(uri.path.endsWith('/src/a.txt'), 'keeps the filename for language detection');
		assert.deepEqual(parseStageEditUri(uri), target);
		assert.equal(parseStageEditUri(vscode.Uri.file('/repo/src/a.txt')), undefined);
	});

	test('builds a HEAD URI in the Git extension shape', () => {
		const uri = toHeadUri('/repo/a.txt');
		assert.deepEqual(JSON.parse(uri.query), { path: '/repo/a.txt', ref: 'HEAD' });
		assert.equal(isIndexUri(uri), false);
	});

	test('describes a staged modification or rename diff tab', () => {
		const tab = fakeTab(
			new vscode.TabInputTextDiff(gitUri('/repo/old.txt', 'HEAD'), gitUri('/repo/new.txt', '')),
		);
		const staged = describeStagedTab(tab);

		assert.ok(staged);
		assert.equal(staged.fsPath, '/repo/new.txt');
		assert.equal(staged.original?.toString(), gitUri('/repo/old.txt', 'HEAD').toString());
	});

	test('describes a staged addition, which the Git extension opens without a left side', () => {
		const staged = describeStagedTab(fakeTab(new vscode.TabInputText(gitUri('/repo/new.txt', ''))));

		assert.ok(staged);
		assert.equal(staged.fsPath, '/repo/new.txt');
		assert.equal(staged.original, undefined);
	});

	test('ignores working-tree diffs and ordinary editors', () => {
		const workingTree = fakeTab(
			new vscode.TabInputTextDiff(gitUri('/repo/a.txt', '~'), vscode.Uri.file('/repo/a.txt')),
		);
		assert.equal(describeStagedTab(workingTree), undefined);
		assert.equal(describeStagedTab(fakeTab(new vscode.TabInputText(vscode.Uri.file('/repo/a.txt')))), undefined);
		assert.equal(describeStagedTab(undefined), undefined);
	});
});
