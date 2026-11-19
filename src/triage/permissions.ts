import type {Issue,Decision} from '../types.js';
export type Action=Decision['kind'];
export function allowedActions(issue:Issue):Action[]{
 if(issue.status==='review'||issue.remoteCase&&['resolved','closed'].includes(issue.remoteCase.status))return ['wait','review'];
 return ['ask',issue.remoteCase?'update':'open','wait','outOfScope','review'];
}
