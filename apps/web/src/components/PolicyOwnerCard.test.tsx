// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../lib/rpc',()=>({rpc:{threads:{followUp:vi.fn(async()=>({ok:true}))}}}));
import { rpc } from '../lib/rpc';
import { PolicyOwnerCard } from './PolicyOwnerCard';
let root:Root,host:HTMLDivElement,fetcher:any;
const row={id:'a'.repeat(64),botId:'b',digest:'d'.repeat(64),status:'pending',expiresAt:'2099-01-01T00:00:00Z',
  review:{reason:'Respect confirmed no-holiday rounds.',purpose:'model_correction',snapshot:{sourceDiff:'-old\n+new',cnlDiff:'-old meaning\n+corrected meaning',candidate:{policy:'workspace/new.rost',cnl:'All confirmed rules'}}}};
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;fetcher=vi.fn(async()=>new Response(JSON.stringify(row),{status:200}));vi.stubGlobal('fetch',fetcher);host=document.createElement('div');root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());vi.unstubAllGlobals();vi.clearAllMocks();});
const render=()=>act(async()=>root.render(<PolicyOwnerCard botId="b" reviewId={row.id}/>));
it('shows exact changes and requires deliberate confirmation without a solve',async()=>{
  await render();expect(host.textContent).toContain('corrected meaning');
  const approve=[...host.querySelectorAll('button')].find(b=>b.textContent==='Approve and continue')!;
  expect(approve.disabled).toBe(true);expect(rpc.threads.followUp).not.toHaveBeenCalled();
  expect(host.querySelector('input[type=password]')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
const button=(label:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===label)!;
const confirm=()=>act(async()=>host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
const reply=(status:string,extra={})=>new Response(JSON.stringify({id:row.id,digest:row.digest,status,...extra}));
it('approves with the existing session and continues once using the same review nonce',async()=>{
  await render();await confirm();fetcher.mockResolvedValueOnce(reply('approved'));
  await act(async()=>button('Approve and continue').click());
  const request=JSON.parse(fetcher.mock.calls[1][1].body);
  expect(request).toEqual({id:row.id,digest:row.digest,decision:'approve',confirmed:true});
  expect(rpc.threads.followUp).toHaveBeenCalledTimes(1);
  expect(rpc.threads.followUp).toHaveBeenCalledWith(expect.objectContaining({clientNonce:'policy-approval:'+row.id}));
  expect(host.textContent).toContain('Policy change recorded');
  expect(host.textContent).not.toContain('Continuation requested');
  expect(host.querySelector('details')!.open).toBe(false);
  expect(host.querySelector('button')).toBeNull();
});
it('does not resume after rejection',async()=>{
  await render();await confirm();fetcher.mockResolvedValueOnce(reply('rejected'));
  await act(async()=>button('Reject').click());expect(rpc.threads.followUp).not.toHaveBeenCalled();expect(host.textContent).toContain('Status: rejected');
});
it.each([['stale',{}],['approved',{digest:'f'.repeat(64)}],['approved',{id:'f'.repeat(64)}]])('does not resume an unconfirmed response %s %j',async(status,extra)=>{
  await render();await confirm();fetcher.mockResolvedValueOnce(reply(status as string,extra));
  await act(async()=>button('Approve and continue').click());expect(rpc.threads.followUp).not.toHaveBeenCalled();expect(host.textContent).toContain('Decision not confirmed');
});
it('preserves an approved receipt and offers idempotent recovery if enqueue fails',async()=>{
  await render();await confirm();fetcher.mockResolvedValueOnce(reply('approved'));
  vi.mocked(rpc.threads.followUp).mockRejectedValueOnce(Error('connection lost'));
  await act(async()=>button('Approve and continue').click());
  expect(host.textContent).toContain('Approval recorded. Continuation not confirmed');
  await act(async()=>button('Continue in chat').click());
  expect(rpc.threads.followUp).toHaveBeenCalledTimes(2);
  expect(vi.mocked(rpc.threads.followUp).mock.calls[0]![0]).toEqual(vi.mocked(rpc.threads.followUp).mock.calls[1]![0]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(host.querySelector('button')).toBeNull();
});
it('never continues when approval fails or the review has expired',async()=>{
  await render();await confirm();fetcher.mockResolvedValueOnce(new Response('{}',{status:409}));
  await act(async()=>button('Approve and continue').click());expect(rpc.threads.followUp).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({...row,expiresAt:'2000-01-01T00:00:00Z'})));
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Refresh approval"]')!.click());
  expect(button('Approve and continue').disabled).toBe(true);
});
it('never leaks another bot review and never resumes automatically after approval',async()=>{
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({...row,botId:'other'})));await render();
  expect(host.textContent).not.toContain('corrected meaning');expect(host.textContent).toContain('unavailable');
});
it('collapses approved revisions on reload without another approval or continuation action',async()=>{
  fetcher.mockResolvedValue(new Response(JSON.stringify({...row,status:'approved'})));await render();
  expect(rpc.threads.followUp).not.toHaveBeenCalled();
  expect(host.querySelector('details')!.open).toBe(false);
  expect(host.querySelector('button')).toBeNull();
  expect(host.querySelector('input')).toBeNull();
  expect(host.querySelector('summary')!.textContent).toBe('Policy change recorded');
  expect(host.textContent).toContain('corrected meaning');
  expect(host.textContent).not.toContain('Status: approved');
});
it.each(['pending','approved','checked','rejected'])('removes historical %s cards in manager-chat mode without enqueueing work',async status=>{
  fetcher.mockResolvedValue(new Response(JSON.stringify({...row,status,approvalMode:'manager_chat'})));await render();
  expect(host.innerHTML).toBe('');expect(rpc.threads.followUp).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledTimes(1);
});
