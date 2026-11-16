import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";

// Dedicated computers only. Never kill the helper or its ancestors. Inspect process
// identity again before signalling, then require all matched writers to be gone.
const stopWriters = String.raw`
import os, signal, time
root='/home/rakazo/workspace'
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
                    if target.startswith('/tmp/rakazo-background-'): workspace_fd=True; break
                    if target==root or target.startswith(root+'/'):
                        info=open(base+'/fdinfo/'+descriptor).read().splitlines()
                        flags=next(int(line.split()[1],8) for line in info if line.startswith('flags:'))
                        if flags & os.O_ACCMODE != os.O_RDONLY: workspace_fd=True; break
                except (OSError,ValueError,StopIteration): pass
            result[pid]=(int(stat[1]),stat[19],stat[0],cmd,cwd,workspace_fd)
        except (OSError,ValueError): pass
    return result
def victims(rows):
    excluded=set(); p=os.getpid()
    while p in rows and p not in excluded: excluded.add(p); p=rows[p][0]
    found=set()
    for pid,(_,_,state,cmd,cwd,workspace_fd) in rows.items():
        if pid in excluded or state=='Z': continue
        if workspace_fd or 'rakazo-background-launch' in cmd or cwd==root or cwd.startswith(root+'/') or root+'/' in cmd or '/opt/rost/' in cmd or ('codex' in cmd and 'app-server' in cmd): found.add(pid)
    changed=True
    while changed:
        children={p for p,r in rows.items() if r[0] in found and p not in excluded and r[2]!='Z'}
        changed=bool(children-found); found|=children
    return found
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

export async function stopCheckpointWriters(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
) {
  let code: number | undefined;
  let output = "";
  for await (const event of sandbox.execute(
    computer,
    {
      argv: ["/opt/office-python/bin/python3", "-I", "-c", stopWriters],
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
