import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { SCHEME, toHeadUri, toStageEditUri } from '../uris';
import { activeEditableTab, openEditable } from '../stagedDiff';
import { TempRepository, createTempRepository } from './tempRepository';

const EXTENSION_ID = 'nmaitre.vscode-stage-edit';

suite('editor flow', () => {
	let repository: TempRepository;

	suiteSetup(async () => {
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
	});

	// These assertions are about index-only writes, so pin the mode rather than inheriting the
	// default — askWhenDirty would raise a modal on a dirty file and stall the run.
	suiteSetup(async () => {
		await vscode.workspace
			.getConfiguration('stageEdit')
			.update('apply.syncWorkingTree', 'whenSafe', vscode.ConfigurationTarget.Global);
	});

	suiteTeardown(async () => {
		await vscode.workspace
			.getConfiguration('stageEdit')
			.update('apply.syncWorkingTree', undefined, vscode.ConfigurationTarget.Global);
	});

	setup(async () => {
		repository = await createTempRepository();
	});

	teardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await repository.dispose();
	});

	function target(relativePath: string) {
		return { repositoryRoot: repository.root, relativePath };
	}

	async function stageModification(): Promise<void> {
		await repository.write('tracked.txt', 'one\nSTAGED\nthree\n');
		await repository.git('add', 'tracked.txt');
		await repository.write('tracked.txt', 'one\nWORKING\nthree\n');
	}

	test('the document opens editable and its save reaches the index', async () => {
		await stageModification();

		const document = await vscode.workspace.openTextDocument(toStageEditUri(target('tracked.txt')));
		assert.equal(document.getText(), 'one\nSTAGED\nthree\n');
		assert.equal(
			document.languageId,
			'plaintext',
			'the URI keeps the filename, so language detection still works',
		);

		const editor = await vscode.window.showTextDocument(document);
		await editor.edit((builder) => builder.insert(new vscode.Position(1, 0), 'INSERTED\n'));
		assert.equal(document.isDirty, true, 'the editable side accepts edits');

		assert.equal(await document.save(), true);
		assert.equal(document.isDirty, false);

		// Saved through VS Code's own pipeline, not just workspace.fs.
		assert.equal(await repository.staged('tracked.txt'), 'one\nINSERTED\nSTAGED\nthree\n');
		assert.equal(
			await repository.read('tracked.txt'),
			'one\nWORKING\nthree\n',
			'the working tree is untouched',
		);
	});

	test('openEditable puts up a diff against HEAD with our scheme on the right', async () => {
		await stageModification();

		const opened = await openEditable({
			target: target('tracked.txt'),
			original: toHeadUri(`${repository.root}/tracked.txt`),
		});
		assert.equal(opened, true);

		const tab = activeEditableTab();
		assert.ok(tab, 'the editable diff should be the active tab');
		assert.ok(tab.input instanceof vscode.TabInputTextDiff);
		assert.equal(tab.input.modified.scheme, SCHEME);
		assert.equal(tab.input.original.scheme, 'git');
	});

	test('openEditable declines a staged deletion', async () => {
		await repository.git('rm', '-q', 'tracked.txt');

		const opened = await openEditable({ target: target('tracked.txt') });
		assert.equal(opened, false);
		assert.equal(activeEditableTab(), undefined);
	});

	test('an addition opens as a single editor, with no HEAD side to diff against', async () => {
		await repository.write('added.txt', 'brand new\n');
		await repository.git('add', 'added.txt');

		const opened = await openEditable({ target: target('added.txt') });
		assert.equal(opened, true);

		const tab = activeEditableTab();
		assert.ok(tab);
		assert.ok(tab.input instanceof vscode.TabInputText);
		assert.equal(tab.input.uri.scheme, SCHEME);
	});
});

suite('working-tree sync through the provider', () => {
	let repository: TempRepository;

	suiteSetup(async () => {
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
	});

	setup(async () => {
		repository = await createTempRepository();
	});

	teardown(async () => {
		await vscode.workspace
			.getConfiguration('stageEdit')
			.update('apply.syncWorkingTree', undefined, vscode.ConfigurationTarget.Global);
		await repository.dispose();
	});

	async function setSyncMode(mode: string): Promise<void> {
		await vscode.workspace
			.getConfiguration('stageEdit')
			.update('apply.syncWorkingTree', mode, vscode.ConfigurationTarget.Global);
	}

	function uriFor(relativePath: string): vscode.Uri {
		return toStageEditUri({ repositoryRoot: repository.root, relativePath });
	}

	async function writeStaged(relativePath: string, content: string): Promise<void> {
		await vscode.workspace.fs.writeFile(uriFor(relativePath), Buffer.from(content, 'utf8'));
	}

	test('whenSafe follows along for a file with nothing to lose', async () => {
		await setSyncMode('whenSafe');
		// tracked.txt is committed and identical on disk, so there are no unstaged changes.

		await writeStaged('tracked.txt', 'one\nEDITED\nthree\n');

		assert.equal(await repository.staged('tracked.txt'), 'one\nEDITED\nthree\n');
		assert.equal(
			await repository.read('tracked.txt'),
			'one\nEDITED\nthree\n',
			'the file on disk follows, so no phantom unstaged diff appears',
		);
	});

	test('whenSafe refuses to clobber unstaged work', async () => {
		await setSyncMode('whenSafe');
		await repository.write('tracked.txt', 'one\nUNSTAGED WORK\nthree\n');

		await writeStaged('tracked.txt', 'one\nEDITED\nthree\n');

		assert.equal(await repository.staged('tracked.txt'), 'one\nEDITED\nthree\n');
		assert.equal(
			await repository.read('tracked.txt'),
			'one\nUNSTAGED WORK\nthree\n',
			'the unstaged edit survives',
		);
	});

	test('always overwrites, unstaged work and all', async () => {
		await setSyncMode('always');
		await repository.write('tracked.txt', 'one\nUNSTAGED WORK\nthree\n');

		await writeStaged('tracked.txt', 'one\nEDITED\nthree\n');

		assert.equal(await repository.read('tracked.txt'), 'one\nEDITED\nthree\n');
	});

	test('never leaves the working tree entirely alone', async () => {
		await setSyncMode('never');

		await writeStaged('tracked.txt', 'one\nEDITED\nthree\n');

		assert.equal(await repository.staged('tracked.txt'), 'one\nEDITED\nthree\n');
		assert.equal(await repository.read('tracked.txt'), 'one\ntwo\nthree\n');
	});

	test('whenSafe does not resurrect a file deleted from disk', async () => {
		await setSyncMode('whenSafe');
		await repository.remove('tracked.txt');

		await writeStaged('tracked.txt', 'one\nEDITED\nthree\n');

		assert.equal(await repository.staged('tracked.txt'), 'one\nEDITED\nthree\n');
		await assert.rejects(() => repository.read('tracked.txt'));
	});
});
