import {expect,it} from 'vitest';
import {developerAccess} from './developer-access.js';
it('developer mode is off by default and requires an explicit operator grant plus deployment ownership',()=>{
  const owner={userId:'operator',isDeploymentOwner:true};
  expect(developerAccess(owner,{})).toBe(false);
  expect(developerAccess(owner,{ROST_DEVELOPER_USER_IDS:'operator'})).toBe(true);
  expect(developerAccess({...owner,isDeploymentOwner:false},{ROST_DEVELOPER_USER_IDS:'operator'})).toBe(false);
  expect(developerAccess(owner,{ROST_DEVELOPER_USER_IDS:'someone-else'})).toBe(false);
});
