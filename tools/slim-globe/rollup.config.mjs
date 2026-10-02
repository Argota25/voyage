import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

export default {
  input: 'entry.js',
  output: {
    file: 'out/globe.slim.min.js',
    format: 'umd',
    name: 'Globe',
    exports: 'default',
    sourcemap: false,
  },
  plugins: [resolve({ browser: true, preferBuiltins: false }), commonjs(), terser()],
};
