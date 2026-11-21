import { brotliCompressSync, gzipSync } from 'node:zlib';

export function bundleReport() {
  return {
    name: 'portos-bundle-report',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const files = Object.keys(bundle).sort().map((fileName) => {
          const output = bundle[fileName];
          const bytes = Buffer.from(output.type === 'chunk' ? output.code : output.source);
          return {
            fileName,
            rawBytes: bytes.length,
            gzipBytes: gzipSync(bytes).length,
            brotliBytes: brotliCompressSync(bytes).length,
          };
        });
        this.emitFile({
          type: 'asset',
          fileName: 'bundle-report.json',
          source: `${JSON.stringify(files, null, 2)}\n`,
        });
      },
    },
  };
}
