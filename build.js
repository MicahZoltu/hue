#!/usr/bin/env bun
// build.js - bundle all assets into a single hue.html for easy sharing.
// No minification, no transforms - just string substitution so the output
// is byte-identical to the source files concatenated into the HTML.
//
// Optional: after the basic build, the script prompts to bake in a
// bridge IP and token so the recipient can skip the connect flow. The
// creds are written into localStorage by a small bootstrap <script>
// injected right after <body>, which runs before app.js initializes.
//
// Run with:  bun build.js
// Output:    hue.html (in the same directory)

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { createInterface } from 'node:readline';
import { stdin, stdout, exit } from 'node:process';

const HERE = dirname(import.meta.path);

const files = {
  html:  'index.html',
  css:   'style.css',
  color: 'color.js',
  hue:   'hue.js',
  core:  'core.js',
  app:   'app.js'
};

function read(name) {
  return readFileSync(join(HERE, files[name]), 'utf8');
}

// --- interactive prompt -------------------------------------------------
//
// Single readline, single 'line' event, FIFO of waiters. Each ask()
// pushes a resolver; the next line the user types pops it. No mixing
// of rl.question() with rl.on('line') (which is the source of subtle
// race bugs when the two handlers both react to the same line).

const rl = createInterface({ input: stdin, output: stdout, terminal: !!stdin.isTTY });
const waiters = [];
rl.on('line', function (line) {
  const w = waiters.shift();
  if (w) w(line);
});
// If stdin closes while we're waiting, resolve with whatever's left
// (handles piped input that ends without an extra newline).
rl.on('close', function () {
  while (waiters.length) waiters.shift()(null);
});

function ask(question) {
  process.stdout.write(question);
  return new Promise(function (resolve) { waiters.push(resolve); });
}

// Multi-line JSON reader. Reads lines one at a time via ask() until
// the user signals "done" by pressing Enter on an empty line after at
// least one non-empty line. If stdin closes mid-paste, returns what
// we have so far.
async function readJson() {
  process.stdout.write('\nPaste the credentials JSON (single or multi-line).\n');
  process.stdout.write('Press Enter on an empty line to submit.\n');
  let buffer = '';
  while (true) {
    const line = await ask('  > ');
    if (line === null) return buffer; // stdin closed
    if (line === '' && buffer.trim() !== '') return buffer;
    buffer += line + '\n';
  }
}

async function askBakedCreds() {
  if (!stdin.isTTY) {
    console.log('(non-interactive stdin detected; skipping credentials prompt)');
    return null;
  }

  const ans = (await ask(
    '\nBake IP + token into hue.html so the recipient can skip pairing? [y/N] '
  )).trim().toLowerCase();
  if (ans !== 'y' && ans !== 'yes') return null;

  process.stdout.write(
    '\n  Heads up: anyone with the file will be able to control your bridge\n' +
    '  while on the same local network. The token is harmless outside your\n' +
    '  network, but only send this to people you would hand a Hue remote to.\n'
  );
  const confirm = (await ask('  Proceed? [y/N] ')).trim().toLowerCase();
  if (confirm !== 'y' && confirm !== 'yes') return null;

  const raw = await readJson();
  if (!raw || !raw.trim()) {
    console.error('\nNo JSON received.');
    exit(1);
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { console.error('\nInvalid JSON: ' + e.message); exit(1); }
  if (!parsed || !parsed.ip || !parsed.token) {
    console.error('\nJSON must include "ip" and "token".');
    exit(1);
  }
  return { ip: String(parsed.ip), token: String(parsed.token) };
}

// --- build --------------------------------------------------------------

let out = read('html')
  .replace(
    /<link rel="stylesheet" href="style\.css">/,
    '<style>\n' + read('css')   + '\n</style>'
  )
  .replace(
    /<script src="color\.js"><\/script>/,
    '<script>\n' + read('color') + '\n</script>'
  )
  .replace(
    /<script src="hue\.js"><\/script>/,
    '<script>\n' + read('hue')   + '\n</script>'
  )
  .replace(
    /<script src="core\.js"><\/script>/,
    '<script>\n' + read('core')  + '\n</script>'
  )
  .replace(
    /<script src="app\.js"><\/script>/,
    '<script>\n' + read('app')   + '\n</script>'
  );

// Guard against silent failures: if a future source file is referenced
// in index.html but we didn't inline it, fail loudly. We look for the
// actual <link>/<script src=...> attributes rather than the bare
// filenames so a comment mentioning a filename in any inlined asset
// doesn't trigger a false positive.
const refs = [
  /<link[^>]+href=["']style\.css["']/,
  /<script[^>]+src=["']color\.js["']/,
  /<script[^>]+src=["']hue\.js["']/,
  /<script[^>]+src=["']core\.js["']/,
  /<script[^>]+src=["']app\.js["']/
];
const remaining = refs.filter(function (re) { return re.test(out); }).map(function (re) {
  return (re.toString().match(/["']([^"']+)["']/) || [])[1];
});
if (remaining.length) {
  throw new Error('Build failed: these assets were not inlined: ' + remaining.join(', '));
}

const bakedCreds = await askBakedCreds();
rl.close();

if (bakedCreds) {
  // Inject a bootstrap script right after <body> so it runs before the
  // app's color/hue/app scripts. localStorage.setItem requires a string
  // value, so we double-stringify: the inner JSON.stringify produces the
  // JSON of the creds; the outer one escapes it into a valid JS string
  // literal that, emitted into the script, becomes
  //   localStorage.setItem("hue.creds", "{\"ip\":...,\"token\":...}")
  // The try/catch covers the rare localStorage-throwing case
  // (e.g. Safari private mode).
  const bootstrap = '<script>\n'
    + 'try { localStorage.setItem("hue.creds", ' + JSON.stringify(JSON.stringify(bakedCreds)) + '); }\n'
    + 'catch (e) { /* localStorage unavailable; user will need to pair manually */ }\n'
    + '</script>';
  out = out.replace('<body>', '<body>\n' + bootstrap);
}

const outPath = join(HERE, 'hue.html');
writeFileSync(outPath, out);
const flag = bakedCreds ? ' [creds baked in for ' + bakedCreds.ip + ']' : '';
process.stdout.write('\nWrote ' + outPath + ' (' + out.length + ' bytes)' + flag + '\n');
