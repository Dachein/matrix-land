import {expect,test} from '@playwright/test';
import {mockPortalApis} from './fixtures/portalApi';

test.beforeEach(async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('workspace-ai:locale','en'));
 await mockPortalApis(page,{modules:['knowledge','studio','discussions','connections']});
});

test('phase-one operations remains available without models or backup services',async({page})=>{
 await page.route('**/api/admin/installation',route=>route.fulfill({json:{release:'0.1.0',modules:['knowledge','studio','discussions','connections'],entraConfigured:false,receipts:[]}}));
 await page.route('**/auth/setup/ownership',route=>route.fulfill({json:{isOwner:true}}));
 await page.goto('/admin/operations');
 await expect(page.getByRole('heading',{name:'Operations & acceptance'})).toBeVisible();
 await expect(page.getByText('You own this workspace',{exact:true})).toBeVisible();
 await expect(page.getByText('Model services are disabled.',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Test model',exact:true})).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Global Data Backups'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Prepare transfer'})).toBeVisible();
});

test('phase-one login settings review and save a domain policy',async({page})=>{
 let policy={mode:'company_email_only',allowedDomains:['matrixland.si'],updatedAt:'2026-11-04'};
 let writes=0;
 await page.route('**/api/admin/login-email-policy',async route=>{
  if(route.request().method()==='POST'){
   const body=route.request().postDataJSON();
   expect(body).toEqual({mode:'company_email_only',allowedDomains:['example.org','matrixland.si']});
   policy={...policy,...body};writes++;
  }
  await route.fulfill({json:{policy}});
 });
 await page.goto('/admin/identity');
 await expect(page.getByRole('heading',{name:'Login and Company Email Policy'})).toBeVisible();
 await page.getByPlaceholder('example.com',{exact:true}).fill('example.org');
 await page.getByRole('button',{name:'Add domain',exact:true}).click();
 await page.getByRole('button',{name:'Review and save policy',exact:true}).click();
 expect(writes).toBe(0);
 await expect(page.getByRole('dialog',{name:'Confirm policy changes'})).toBeVisible();
 await page.getByRole('button',{name:'Confirm and save policy',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('policy saved');
 expect(writes).toBe(1);
 await page.reload();
 await expect(page.locator('.portal-admin-domain-list')).toContainText('example.org');
});

test('phase-one member management is available without model services',async({page})=>{
 await page.goto('/admin/people');
 await expect(page.getByRole('heading',{name:'Registered users and permissions'})).toBeVisible();
 await expect(page.getByPlaceholder('Search name, email, community level or department')).toBeVisible();
});
