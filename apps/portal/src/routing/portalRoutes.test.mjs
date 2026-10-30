import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {parsePortalRoute,portalRoutePath,navKeyForRoute,browserUrlForPortalRoute} from './portalRoutes.ts';
const cases=[
 ['/home',{page:'landing',section:'home'},'home'],['/discussions',{page:'landing',section:'discussions'},'discussions'],
 ['/discussions/topic-1',{page:'post',postId:'topic-1'},'discussions'],['/catalog',{page:'catalog'},'catalog'],
 ['/catalog/apps/app-1',{page:'app',appId:'app-1'},'catalog'],['/catalog/skills/skill-1',{page:'skill',skillId:'skill-1'},'catalog'],
 ['/studio',{page:'studio'},'studio'],['/models',{page:'models'},'models'],['/models/status',{page:'model-status'},'models'],
 ['/knowledge',{page:'knowledge',section:'my'},'knowledge'],['/knowledge/services',{page:'knowledge',section:'services'},'knowledge'],['/knowledge/recent',{page:'knowledge',section:'recent'},'knowledge'],
 ['/mate',{page:'mate'},'mate'],['/mate/mate-1',{page:'mate',mateId:'mate-1'},'mate'],['/mate/mate-1/conversations/conversation-1',{page:'mate',mateId:'mate-1',conversationId:'conversation-1'},'mate'],
 ['/mate/mate-1/preview?release=release-1&debug=1',{page:'mate-preview',mateId:'mate-1',releaseId:'release-1',debug:true},'mate'],
 ['/mate/mate-1/embed?conversation=c-1&embedInstance=i-1',{page:'mate-embed',mateId:'mate-1',conversationId:'c-1',embedInstanceId:'i-1',presentation:'embedded'},'mate'],
 ['/connections',{page:'connections'},'connections'],['/admin/models',{page:'admin',section:'tokens'},'admin'],['/admin/models/usage',{page:'admin',section:'usage'},'admin'],
 ['/admin/models/allocations',{page:'admin',section:'allocations'},'admin'],['/admin/people',{page:'admin-users'},'admin-users'],['/admin/identity',{page:'admin-login-policy'},'admin-login-policy'],['/admin/operations',{page:'admin-backups'},'admin-backups'],['/admin/publishing',{page:'admin-hub-review'},'admin-hub-review'],['/admin/integrations',{page:'admin-mcp-connections'},'admin-mcp-connections'],['/admin/knowledge',{page:'admin-knowledge'},'admin-knowledge']
];
describe('Frontier Workspace history routes',()=>{
 for(const [path,route,owner]of cases)it(`round-trips ${path}`,()=>{assert.deepEqual(parsePortalRoute(path),route);assert.equal(portalRoutePath(route),path);assert.equal(browserUrlForPortalRoute(route),path);assert.equal(navKeyForRoute(route),owner);});
 it('rejects retired aliases, hash navigation and malformed object coordinates',()=>{for(const path of ['#/home','/skills-apps','/apps/app-1','/posts/topic-1','/token','/lego','/teammate','/mcp-handbook','//attacker.test','https://attacker.test','/catalog/apps/%2Fetc','/discussions/topic%201','/mate/mate-1/preview','/mate/mate-1/conversations','/mate/%ZZ','/unknown'])assert.deepEqual(parsePortalRoute(path),{page:'not-found'},path);});
 it('supports the root and trailing slash without exposing another protocol',()=>{assert.deepEqual(parsePortalRoute('/'),{page:'landing',section:'home'});assert.deepEqual(parsePortalRoute('/home/'),{page:'landing',section:'home'});});
});
