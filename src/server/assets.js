const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function createAssetsResolver(rootDir) {
  const manifestPath = path.join(rootDir, 'public', 'dist', 'manifest.json');
  let cachedAssets = null;

  function resolve() {
    if (cachedAssets && process.env.NODE_ENV === 'production') {
      return cachedAssets;
    }

    if (!fs.existsSync(manifestPath)) {
      return {
        ready: false,
        js: null,
        css: [],
        preloadFonts: [],
        swAssets: [],
        swVersion: 'v2'
      };
    }

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const entry = manifest['src/client/main.js'];
      if (!entry || !entry.file) {
        return { ready: false, js: null, css: [], preloadFonts: [], swAssets: [], swVersion: 'v2' };
      }

      const preloadFonts = [];
      const swAssetSet = new Set();
      swAssetSet.add(`/dist/${entry.file}`);

      const cssFiles = Array.isArray(entry.css) ? entry.css.map((f) => `/dist/${f}`) : [];
      for (const cssHref of cssFiles) {
        swAssetSet.add(cssHref);
      }

      for (const item of Object.values(manifest)) {
        if (item && typeof item.file === 'string' && item.file.endsWith('.woff2')) {
          if (/manrope.*latin/i.test(item.file)) {
            swAssetSet.add(`/dist/${item.file}`);
          }
          if (/manrope-latin-wght-normal/i.test(item.file)) {
            preloadFonts.push(`/dist/${item.file}`);
          }
        }
      }

      const swAssets = Array.from(swAssetSet);
      const swVersion = crypto
        .createHash('sha1')
        .update(swAssets.join('|'))
        .digest('hex')
        .slice(0, 10);

      const resolved = {
        ready: true,
        js: `/dist/${entry.file}`,
        css: cssFiles,
        preloadFonts: Array.from(new Set(preloadFonts)).slice(0, 1),
        swAssets,
        swVersion: `v2-${swVersion}`
      };

      if (process.env.NODE_ENV === 'production') {
        cachedAssets = resolved;
      }
      return resolved;
    } catch (error) {
      console.warn('Unable to read Vite manifest:', error.message);
      return { ready: false, js: null, css: [], preloadFonts: [], swAssets: [], swVersion: 'v2' };
    }
  }

  return { resolve };
}

module.exports = {
  createAssetsResolver
};
