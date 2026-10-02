import { rollup } from 'rollup';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

const b = await rollup({ input: 'entry.js',
  plugins: [resolve({ browser: true, preferBuiltins: false }), commonjs()] });
const { output } = await b.generate({ format: 'umd', name: 'Globe', exports: 'default' });
const mods = output[0].modules;
const byPkg = {};
for (const [id, m] of Object.entries(mods)) {
  const norm = id.split('\\').join('/');
  const mm = norm.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  const pkg = mm ? mm[1] : '(app)';
  byPkg[pkg] = (byPkg[pkg] || 0) + m.renderedLength;
}
const rows = Object.entries(byPkg).sort((a, b2) => b2[1] - a[1]);
for (const [p, n] of rows) console.log(String((n / 1024) | 0).padStart(6) + ' KB  ' + p);
console.log('TOTAL', (output[0].code.length / 1024) | 0, 'KB unminified');
