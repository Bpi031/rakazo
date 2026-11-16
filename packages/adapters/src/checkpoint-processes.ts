import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";
import { managedWorkspace } from "./managed-workspace.js";

// Never kill the helper or its ancestors. Inspect process
// identity again before signalling, then require all matched writers to be gone.
const processInspection = String.raw`
import os, signal, time
roots=checkpoint_roots
def under_workspace(value): return any(value==root or value.startswith(root+'/') for root in roots)
def processes():
    result={}
    for name in os.listdir('/proc'):
        if not name.isdigit(): continue
        try:
            pid=int(name); base='/proc/'+name
            stat=open(base+'/stat').read().rsplit(')',1)[1].split()
            cmd=open(base+'/cmdline','rb').read().replace(b'\0',b' ').decode(errors='replace')
            cwd=os.readlink(base+'/cwd')
            workspace_fd=False
            for descriptor in os.listdir(base+'/fd'):
                try:
                    target=os.readlink(base+'/fd/'+descriptor)
                    if not checkpoint_team and target.startswith('/tmp/rakazo-background-'): workspace_fd=True; break
                    if under_workspace(target):
                        info=open(base+'/fdinfo/'+descriptor).read().splitlines()
                        flags=next(int(line.split()[1],8) for line in info if line.startswith('flags:'))
                        if flags & os.O_ACCMODE != os.O_RDONLY: workspace_fd=True; break
                except (OSError,ValueError,StopIteration): pass
            result[pid]=(int(stat[1]),stat[19],stat[0],cmd,cwd,workspace_fd)
        except (OSError,ValueError): pass
    return result
def victims(rows, idle=False):
    excluded=set(); p=os.getpid()
    while p in rows and p not in excluded: excluded.add(p); p=rows[p][0]
    found=set()
    for pid,(_,_,state,cmd,cwd,workspace_fd) in rows.items():
        if pid in excluded or state=='Z': continue
        if idle and 'codex' in cmd and 'app-server' in cmd and not workspace_fd: continue
        native='codex' in cmd and 'app-server' in cmd
        # A peer's idle native session is not part of this Bot's private root.
        # Only processes touching this Bot's archived root belong to its checkpoint.
        if checkpoint_team and native and not workspace_fd and not under_workspace(cwd): continue
        if workspace_fd or under_workspace(cwd) or any(root+'/' in cmd for root in roots) or (not checkpoint_team and ('rakazo-background-launch' in cmd or 'rakazo-terminal.py' in cmd or '/opt/rost/' in cmd or native)): found.add(pid)
    changed=True
    while changed:
        children={p for p,r in rows.items() if r[0] in found and p not in excluded and r[2]!='Z'}
        changed=bool(children-found); found|=children
    return found
`;

function inspection(script: string, scope: ComputerMode, botId: string | undefined) {
  const workspace = managedWorkspace(scope, botId ?? "");
  const roots = scope === "team" ? [workspace.roots[0]] : workspace.roots;
  return `checkpoint_roots=${JSON.stringify(roots)}\ncheckpoint_team=${scope === "team" ? "True" : "False"}\n${script}`;
}

const idleWriters =
  processInspection +
  `
if victims(processes(), idle=True): raise RuntimeError('Workspace has running writers')
print('checkpoint-writers-idle')
`;

const stopWriters =
  processInspection +
  `
for sig in [signal.SIGTERM,signal.SIGKILL]:
    rows=processes()
    for pid in victims(rows):
        current=processes().get(pid)
        if current and current[1]==rows[pid][1]:
            try: os.kill(pid,sig)
            except ProcessLookupError: pass
    time.sleep(0.3)
if victims(processes()): raise RuntimeError('Workspace writers did not stop')
print('checkpoint-writers-stopped')
`;

export async function assertCheckpointWritersIdle(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  scope: ComputerMode = "dedicated",
) {
  let code: number | undefined;
  let output = "";
  for await (const event of sandbox.execute(
    computer,
    {
      argv: [
        "/opt/office-python/bin/python3",
        "-I",
        "-c",
        inspection(idleWriters, scope, context.botId),
      ],
      cwd: "/home/rakazo",
      timeoutMs: 5_000,
    },
    context,
  )) {
    if (event.type === "stdout") output += event.data;
    if (event.type === "exit") code = event.code;
  }
  if (code !== 0 || !output.includes("checkpoint-writers-idle"))
    throw new Error("Wait for workspace writers to finish before saving");
}

export async function stopCheckpointWriters(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  scope: ComputerMode = "dedicated",
) {
  let code: number | undefined;
  let output = "";
  for await (const event of sandbox.execute(
    computer,
    {
      argv: [
        "/opt/office-python/bin/python3",
        "-I",
        "-c",
        inspection(stopWriters, scope, context.botId),
      ],
      cwd: "/home/rakazo",
      timeoutMs: 15_000,
    },
    context,
  )) {
    if (event.type === "stdout") output += event.data;
    if (event.type === "exit") code = event.code;
  }
  if (code !== 0 || !output.includes("checkpoint-writers-stopped"))
    throw new Error("Could not confirm workspace tasks stopped");
}
