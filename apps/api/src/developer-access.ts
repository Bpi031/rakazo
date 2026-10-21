import type {Actor} from '@rakazo/contracts';

export function developerAccess(actor:Pick<Actor,'userId'|'isDeploymentOwner'>,env:NodeJS.ProcessEnv=process.env) {
  return actor.isDeploymentOwner===true && (env.ROST_DEVELOPER_USER_IDS??'').split(',').map(v=>v.trim()).filter(Boolean).includes(actor.userId);
}
