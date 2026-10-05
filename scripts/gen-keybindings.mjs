// Generates contributes.keybindings in package.json.
//
// VS Code gives no API event for "the user tried to type in a read-only editor" — the
// editor swallows the keystroke and shows its own toast. To offer editing at the moment
// someone tries to type in a staged diff, we bind the keys that start an edit to
// stageEdit.promptEnable, gated on a context key the extension only sets while a
// read-only staged diff is focused and editing is not already enabled for it. When the
// context key is false the bindings do not match at all, so typing is untouched
// everywhere else.
//
// Run with: npm run gen:keybindings

import { readFileSync, writeFileSync } from 'node:fs';

const WHEN =
	'stageEdit.stagedDiffActive && editorTextFocus && !stageEdit.promptActive && ' +
	'config.stageEdit.promptOnKeypress && config.stageEdit.editing.default != never';

const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
const digits = '0123456789'.split('');
const punctuation = ['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`'];
const editingKeys = ['space', 'enter', 'backspace', 'delete', 'tab'];

const keys = [
	...letters,
	...letters.map((k) => `shift+${k}`),
	...digits,
	...punctuation,
	...editingKeys,
];

const keybindings = keys.map((key) => ({
	key,
	command: 'stageEdit.promptEnable',
	when: WHEN,
}));

// Paste and cut are the other two ways an edit starts.
for (const key of ['v', 'x']) {
	keybindings.push({
		key: `ctrl+${key}`,
		mac: `cmd+${key}`,
		command: 'stageEdit.promptEnable',
		when: WHEN,
	});
}

const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.contributes.keybindings = keybindings;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`Wrote ${keybindings.length} keybindings to package.json`);
