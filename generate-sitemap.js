const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = __dirname;
const BASE_URL = 'https://labadconsultoria.es';
const SITEMAP_PATH = path.join(ROOT_DIR, 'sitemap.xml');

function findHtmlFiles(directory){
  const files = [];
  const entries = fs.readdirSync(directory, {withFileTypes:true});
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  for(const entry of entries){
    if(entry.isDirectory()){
      if(entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      files.push(...findHtmlFiles(path.join(directory, entry.name)));
      continue;
    }

    if(entry.isFile() && path.extname(entry.name).toLowerCase() === '.html'){
      files.push(path.join(directory, entry.name));
    }
  }

  return files;
}

function getPageUrl(relativePath){
  const segments = relativePath.split('/');
  const isIndex = segments[segments.length - 1] === 'index.html';
  if(isIndex) segments.pop();

  const encodedPath = segments.map(segment => encodeURIComponent(segment)).join('/');
  if(!encodedPath) return `${BASE_URL}/`;

  return `${BASE_URL}/${encodedPath}${isIndex ? '/' : ''}`;
}

function getPriority(relativePath){
  if(relativePath === 'index.html') return '1.0';

  const fileName = path.posix.basename(relativePath);
  if(fileName === 'quienes-somos.html' || fileName === 'servicios.html') return '0.9';

  return '0.8';
}

const htmlFiles = findHtmlFiles(ROOT_DIR)
  .map(file => path.relative(ROOT_DIR, file).split(path.sep).join('/'))
  .sort();

const urls = htmlFiles.map(relativePath => `  <url>\n    <loc>${getPageUrl(relativePath)}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>${getPriority(relativePath)}</priority>\n  </url>`);

const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...urls,
  '</urlset>',
  ''
].join('\n');

fs.writeFileSync(SITEMAP_PATH, sitemap, 'utf8');
console.log(`Generated sitemap.xml with ${htmlFiles.length} HTML pages.`);
