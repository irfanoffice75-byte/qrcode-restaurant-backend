const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Since node doesn't have a native recursive unzip, we will just use child_process on Railway
// Railway's Nixpacks images have the standard 'unzip' command available.
const { execSync } = require('child_process');

try {
  console.log('Extracting www.zip...');
  if (!fs.existsSync(path.join(__dirname, 'www'))) {
    fs.mkdirSync(path.join(__dirname, 'www'));
  }
  try {
    execSync('unzip -o www.zip -d www', { stdio: 'inherit' });
  } catch (e) {
    if (fs.existsSync(path.join(__dirname, 'www', 'index.html'))) {
      console.log('Unzip threw a warning, but extraction was successful!');
    } else {
      throw e;
    }
  }
  console.log('Extraction complete!');
} catch (error) {
  console.error('Failed to extract www.zip:', error.message);
  process.exit(1);
}
