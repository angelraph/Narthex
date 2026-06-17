import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import fs from 'fs';
import path from 'path';

const dir = path.resolve('.');

async function run() {
  console.log("Initializing local git repository...");
  await git.init({ fs, dir });

  // Set default branch to main
  console.log("Setting default branch to 'main'...");
  fs.writeFileSync(path.join(dir, '.git/HEAD'), 'ref: refs/heads/main\n');

  console.log("Analyzing status matrix...");
  const matrix = await git.statusMatrix({ fs, dir });

  // Status matrix returns [filepath, head, workdir, stage]
  for (const [filepath, head, workdir, stage] of matrix) {
    // Exclude target directories, node_modules, and environment credentials
    if (
      filepath.startsWith('node_modules/') ||
      filepath.includes('/target/') ||
      filepath.startsWith('target/') ||
      filepath.startsWith('.git/') ||
      filepath.startsWith('.gemini/') ||
      filepath.startsWith('scripts/push.js') // Don't commit the push script with the PAT credentials!
    ) {
      continue;
    }

    // workdir = 2 means file exists in working dir, stage != 2 means not yet staged/committed
    if (workdir === 2 && stage !== 2) {
      console.log(`Adding ${filepath}...`);
      await git.add({ fs, dir, filepath });
    }
  }

  console.log("Creating initial commit...");
  const sha = await git.commit({
    fs,
    dir,
    message: 'Initialize ZK-SEP-57 Compliance Shield on Soroban',
    author: {
      name: 'angelraph',
      email: 'angelraph@users.noreply.github.com'
    }
  });
  console.log(`Commit created successfully: ${sha}`);

  // Manage existing remote configurations
  const remotes = await git.listRemotes({ fs, dir });
  const hasOrigin = remotes.some(r => r.remote === 'origin');
  if (hasOrigin) {
    console.log("Removing existing origin remote...");
    await git.deleteRemote({ fs, dir, remote: 'origin' });
  }

  console.log("Configuring remote origin: https://github.com/angelraph/Narthex.git");
  await git.addRemote({
    fs,
    dir,
    remote: 'origin',
    url: 'https://github.com/angelraph/Narthex.git'
  });

  console.log("Pushing commit to GitHub...");
  const result = await git.push({
    fs,
    http,
    dir,
    remote: 'origin',
    ref: 'main',
    force: true,
    onAuth: () => ({
      username: 'angelraph',
      password: 'github_pat_'
    })
  });

  if (result.ok) {
    console.log("\n==========================================");
    console.log("SUCCESS: Project pushed to GitHub repository!");
    console.log("URL: https://github.com/angelraph/Narthex");
    console.log("==========================================\n");
  } else {
    console.error("Push failed:", result);
    process.exit(1);
  }
}

run().catch(err => {
  console.error("Push script encountered an error:", err);
  process.exit(1);
});
