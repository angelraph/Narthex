// 1. Monkey-patch the path module to force forward slashes BEFORE any other imports
import path from 'path';

const originalJoin = path.join;
path.join = function (...args) {
  return originalJoin(...args).replace(/\\/g, '/');
};

const originalResolve = path.resolve;
path.resolve = function (...args) {
  return originalResolve(...args).replace(/\\/g, '/');
};

const originalRelative = path.relative;
path.relative = function (from, to) {
  return originalRelative(from, to).replace(/\\/g, '/');
};

// 2. Now import Noir WASM and fs
import { createFileManager, compile_program } from '@noir-lang/noir_wasm';
import fs from 'fs';

async function run() {
  console.log("Compiling Noir circuit with POSIX-patched path module...");
  const projectPath = path.resolve('circuits');
  console.log("Resolved project path:", projectPath);
  
  const fm = createFileManager(projectPath);
  
  try {
    const compiled = await compile_program(fm);
    
    const targetDir = path.join(projectPath, 'target');
    fs.mkdirSync(targetDir, { recursive: true });
    
    fs.writeFileSync(
      path.join(targetDir, 'compliance_shield.json'), 
      JSON.stringify(compiled, null, 2)
    );
    console.log("Successfully compiled! Saved to circuits/target/compliance_shield.json");
  } catch (err) {
    console.error("Compilation failed:", err);
    process.exit(1);
  }
}

run();
