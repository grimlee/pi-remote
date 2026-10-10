import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
for (const name of ['rich','math']) await build({entryPoints:[`pwa/vendor-src/${name}.js`],outfile:`pwa/public/vendor/${name}.js`,bundle:true,format:'esm',minify:true,legalComments:'eof'});
await cp('node_modules/katex/dist/katex.min.css','pwa/public/vendor/katex.css');
await cp('node_modules/katex/dist/fonts','pwa/public/vendor/fonts',{recursive:true});
await cp('node_modules/highlight.js/styles/github-dark.css','pwa/public/vendor/highlight.css');
for (const name of ['marked','dompurify','highlight.js','katex']) {
  const filename = name === 'dompurify' ? 'LICENSE' : ['highlight.js','katex'].includes(name) ? 'LICENSE' : 'LICENSE.md';
  await writeFile(`pwa/public/vendor/${name}-LICENSE.txt`,await readFile(`node_modules/${name}/${filename}`));
}
