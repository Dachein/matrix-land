import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Synthetic Runtime only: no credentials, conversation payloads or production content. */
async function mountApprovals(page: Page) {
  await page.route('**/approval-review-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('/approval-review-test');
  await page.evaluate(async () => {
    const refreshPath = '/@react-refresh';
    (await import(refreshPath)).default.injectIntoGlobalHook(window);
    Object.assign(window, { $RefreshReg$: () => {}, $RefreshSig$: () => (type: unknown) => type, __vite_plugin_react_preamble_installed__: true });
    const reactPath = '/node_modules/.vite/deps/react.js';
    const clientPath = '/node_modules/.vite/deps/react-dom_client.js';
    const componentPath = '/src/components/FolderEditApprovals.tsx';
    const localePath = '/src/locale.tsx';
    const cssPath = '/src/styles.css';
    const [ReactModule, clientModule, component, locale] = await Promise.all([
      import(reactPath), import(clientPath), import(componentPath), import(localePath), import(cssPath)
    ]);
    const React = ReactModule.default ?? ReactModule;
    const client = clientModule.default ?? clientModule;
    const make = (id: string, args: Record<string, unknown>, fileName: string) => ({
      id, taskId: `task-${id}`, status: 'pending', releaseId: 'release', conversationId: 'conversation',
      expiresAt: '2099-10-14T12:00:00.000Z',
      operation: { type: 'workspace_knowledge_maintenance', toolName: 'knowledge_library_write',
        arguments: { action: 'edit', objectId: `file-${id}`, ...args }, display: { fileName, path: `/研究资料/机构信息/${fileName}` } }
    });
    const approvals = [
      make('a', { operation: 'append_text', text: '## 新增合作条款\n\n| 项目 | 更新内容 |\n| --- | --- |\n| 开户门槛 | 100 万美元 |\n| 交易佣金 | 按产品单独约定 |\n\n**备注：** 生效前需核对最新协议。' }, '合作机构说明.md'),
      make('b', { operation: 'apply_patch', patch: '--- a/产品费率.md\n+++ b/产品费率.md\n@@ -1,3 +1,3 @@\n ## 产品费率\n-基金申购费：1.5%\n+基金申购费：1.0%\n 其他条款保持原样。' }, '产品费率.md'),
      { ...make('other', { operation: 'append_text', text: 'Other conversation' }, 'other.md'), conversationId: 'other' }
    ];
    const tasks = approvals.map(a => ({ id: a.taskId, status: 'waiting_for_approval', conclusion: { summary: '', failures: [] as Array<Record<string, unknown>> } }));
    const pending = new Map<string, (outcome: string) => void>();
    const requests: Array<{ id: string; decision: string }> = [];
    const control = {
      requests, diagnostic: false, inlineTasks: false, failReads: false, loseResponse: false, staleReads: false, taskReadsFail: false,
      complete(id: string, outcome = 'completed') { pending.get(id)?.(outcome); },
      setContent(id: string, text: string) { approvals.find(a => a.id === id)!.operation.arguments = { action: 'edit', objectId: `file-${id}`, operation: 'append_text', text }; },
      expire(id: string) { approvals.find(a => a.id === id)!.expiresAt = '2000-01-01T00:00:00.000Z'; },
      setStatus(id: string, status: string, taskStatus: string) {
        approvals.find(a => a.id === id)!.status = status;
        tasks.find(a => a.id === `task-${id}`)!.status = taskStatus;
      }
    };
    Object.assign(window, { approvalHarness: control });
    const fetcher = async (input: string, init: RequestInit) => {
      if ((init.headers as Record<string, string>).Authorization !== 'Bearer synthetic') throw new Error('unexpected_identity');
      if (input.endsWith('/decision')) {
        const id = decodeURIComponent(input.split('/').at(-2)!);
        const decision = JSON.parse(init.body as string).decision;
        requests.push({ id, decision });
        const outcome = await new Promise<string>(resolve => pending.set(id, resolve));
        const approval = approvals.find(a => a.id === id)!;
        approval.status = decision === 'deny' ? 'denied' : 'consumed';
        const task = tasks.find(t => t.id === approval.taskId)!;
        task.status = decision === 'deny' ? 'cancelled' : outcome;
        task.conclusion.summary = outcome === 'failed' ? '文件版本已更新，请重新生成提案。' : '此项已处理';
        if (control.diagnostic && outcome === 'failed') {
          task.conclusion.failures = [{ code: 'knowledge_edit_patch_invalid', upstreamStatus: 400, upstreamCode: 'knowledge_worker_request_failed', requestId: 'mcp-test-request', causeRequestId: 'knowledge-test-request' }];
        }
        if (control.loseResponse) throw new Error('network_response_lost');
        return Response.json({ approval, task });
      }
      if (control.failReads) return Response.json({ error: 'unavailable' }, { status: 400 });
      if (input.includes('/tasks')) return control.taskReadsFail
        ? Response.json({ error: 'unavailable' }, { status: 400 }) : Response.json({ tasks });
      return Response.json({ approvals: control.inlineTasks ? approvals.map(a => ({ ...a, task: tasks.find(t => t.id === a.taskId) })) : control.staleReads ? approvals.map(a => ({ ...a, status: 'pending' })) : approvals });
    };
    const accessToken = async () => 'synthetic';
    function Harness() {
      const [version, setVersion] = React.useState(0);
      const [conversationId, setConversation] = React.useState('conversation');
      return React.createElement(locale.MateLocaleProvider, { locale: 'zh-CN' },
        React.createElement('main', { className: 'tm-preview-host', style: { display: 'block', height: 'auto', minHeight: '100vh', overflow: 'visible', padding: '24px' } },
          React.createElement(component.FolderEditApprovals, {
            key: version, session: { mode: 'live', runtimeOrigin: 'https://synthetic.test', mate: { id: 'mate' }, release: { id: 'release' } },
            accessToken, fetcher, refreshKey: '1', conversationId
          }),
          React.createElement('nav', { style: { maxWidth: '880px', margin: '0 auto' } },
            React.createElement('button', { onClick: () => setVersion(version + 1) }, '重新加载页面状态'),
            React.createElement('button', { onClick: () => setConversation('other') }, '切换对话'))
        )
      );
    }
    client.createRoot(document.getElementById('root')).render(React.createElement(Harness));
  });
  await expect(page.locator('.tm-approval-card')).toHaveCount(2);
}
const card = (page: Page, id: string) => page.locator(`[data-approval-id="${id}"]`);
async function control(page: Page, code: 'complete' | 'status' | 'flags', value: any) {
  await page.evaluate(({ code, value }) => {
    const api = (window as any).approvalHarness;
    if (code === 'complete') api.complete(value.id, value.outcome);
    else if (code === 'status') api.setStatus(value.id, value.status, value.taskStatus);
    else Object.assign(api, value);
  }, { code, value });
}
async function capture(page: Page, name: string) {
  if (!process.env.APPROVAL_REVIEW_SCREENSHOTS) return;
  const directory = resolve('output/playwright/approval-review');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true });
}

test('single confirmation keeps another approval pending and retains results after reload', async ({ page }) => {
  await mountApprovals(page);
  await card(page, 'a').getByRole('button', { name: '本次新增内容', exact: true }).click();
  await expect(card(page, 'a').getByRole('table')).toContainText('100 万美元');
  await expect(card(page, 'b').locator('.is-added')).toContainText('1.0%');
  await capture(page, 'before-confirmation');
  await card(page, 'b').getByRole('button', { name: '修改后的片段', exact: true }).click();
  await expect(card(page, 'b').locator('.tm-approval-preview')).toContainText('基金申购费：1.0%');
  await expect(card(page, 'b').locator('.tm-approval-preview')).not.toContainText('1.5%');
  await card(page, 'b').getByRole('button', { name: '修改差异', exact: true }).click();
  await card(page, 'a').getByRole('button', { name: '确认这项修改' }).click();
  await expect(card(page, 'a')).toHaveAttribute('data-status', 'executing');
  await expect(card(page, 'b').getByRole('button', { name: '确认这项修改' })).toBeEnabled();
  await expect(card(page, 'b')).toHaveAttribute('data-status', 'pending');
  await control(page, 'complete', { id: 'a' });
  await expect(card(page, 'a')).toHaveAttribute('data-status', 'completed');
  await expect(card(page, 'a').getByRole('button', { name: '确认这项修改' })).toHaveCount(0);
  await expect(card(page, 'a').getByRole('button', { name: '查看修改' })).toBeVisible();
  await expect(page.locator('.tm-approval-card').first()).toHaveAttribute('data-approval-id', 'a');
  expect(await page.evaluate(() => (window as any).approvalHarness.requests)).toEqual([{ id: 'a', decision: 'approve' }]);
  await capture(page, 'after-confirmation');
  await page.getByRole('button', { name: '重新加载页面状态' }).click();
  await expect(card(page, 'a')).toHaveAttribute('data-status', 'completed');
  await expect(card(page, 'b')).toHaveAttribute('data-status', 'pending');
});

test('independent simultaneous decisions preserve each result and failure after reload', async ({ page }) => {
  await mountApprovals(page);
  await card(page, 'a').getByRole('button', { name: '确认这项修改' }).click();
  await card(page, 'b').getByRole('button', { name: '确认这项修改' }).click();
  await control(page, 'complete', { id: 'b', outcome: 'failed' });
  await expect(card(page, 'b')).toHaveAttribute('data-status', 'failed');
  await expect(card(page, 'a')).toHaveAttribute('data-status', 'executing');
  await control(page, 'complete', { id: 'a' });
  await expect(card(page, 'a')).toHaveAttribute('data-status', 'completed');
  await page.getByRole('button', { name: '重新加载页面状态' }).click();
  await expect(card(page, 'b')).toHaveAttribute('data-status', 'failed');
  await expect(card(page, 'b')).toContainText('文件版本已更新');
});

test('a denied item stays declined without approving another item', async ({ page }) => {
  await mountApprovals(page);
  await card(page, 'a').getByRole('button', { name: '拒绝此项' }).click();
  await control(page, 'complete', { id: 'a' });
  await expect(card(page, 'a')).toHaveAttribute('data-status', 'denied');
  await expect(card(page, 'b')).toHaveAttribute('data-status', 'pending');
  await page.getByRole('button', { name: '重新加载页面状态' }).click();
  await expect(card(page, 'a')).toHaveAttribute('data-status', 'denied');
});

test('lost decision response recovers from authoritative reads without replay', async ({ page }) => {
  await mountApprovals(page);
  await control(page, 'flags', { loseResponse: true, failReads: true });
  await card(page, 'a').getByRole('button', { name: '确认这项修改' }).click();
  await control(page, 'complete', { id: 'a' });
  await expect(card(page, 'a')).toContainText('尚未确认此项的执行结果');
  await expect(card(page, 'a').getByRole('button', { name: '确认这项修改' })).toBeDisabled();
  await expect(card(page, 'b').getByRole('button', { name: '确认这项修改' })).toBeEnabled();
  await control(page, 'flags', { failReads: false });
  await card(page, 'a').getByRole('button', { name: '刷新此项状态' }).click();
  await expect(card(page, 'a')).toHaveAttribute('data-status', 'completed');
  expect(await page.evaluate(() => (window as any).approvalHarness.requests.length)).toBe(1);
});

test('stale or failed refresh cannot undo a known successful result', async ({ page }) => {
  await mountApprovals(page);
  await control(page, 'flags', { staleReads: true });
  await card(page, 'a').getByRole('button', { name: '确认这项修改' }).click();
  await control(page, 'complete', { id: 'a' });
  await expect(card(page, 'a')).toHaveAttribute('data-status', 'completed');
  await expect(card(page, 'b')).toHaveAttribute('data-status', 'pending');
  await control(page, 'flags', { failReads: true });
  await card(page, 'b').getByRole('button', { name: '拒绝此项' }).click();
  await control(page, 'complete', { id: 'b' });
  await expect(card(page, 'b')).toHaveAttribute('data-status', 'denied');
  await expect(card(page, 'a')).toHaveAttribute('data-status', 'completed');
});

test('consumed approval with unavailable task result never claims completion', async ({ page }) => {
  await mountApprovals(page);
  await control(page, 'status', { id: 'a', status: 'consumed', taskStatus: 'running' });
  await control(page, 'flags', { taskReadsFail: true });
  await page.getByRole('button', { name: '重新加载页面状态' }).click();
  await expect(card(page, 'a')).toHaveAttribute('data-status', 'executing');
  await expect(card(page, 'a')).toContainText('正在核对执行结果');
  await expect(card(page, 'a').getByRole('button', { name: '确认这项修改' })).toHaveCount(0);
});

test('changing conversation ignores an old in-flight decision', async ({ page }) => {
  await mountApprovals(page);
  await card(page, 'a').getByRole('button', { name: '确认这项修改' }).click();
  await page.getByRole('button', { name: '切换对话' }).click();
  await expect(card(page, 'other')).toBeVisible();
  await control(page, 'complete', { id: 'a' });
  await expect(card(page, 'a')).toHaveCount(0);
  await expect(card(page, 'other')).toHaveAttribute('data-status', 'pending');
});

test('mobile card keeps tables within the preview and exposes clear controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountApprovals(page);
  await card(page, 'a').getByRole('button', { name: '本次新增内容', exact: true }).click();
  await expect(card(page, 'a').getByRole('table')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(card(page, 'a').getByRole('button', { name: '确认这项修改' })).toBeVisible();
  await capture(page, 'mobile-review');
});

test('Markdown review escapes HTML, blocks remote images and preserves literal file markers', async ({ page }) => {
  await mountApprovals(page);
  await page.evaluate(() => (window as any).approvalHarness.setContent('a', '<script>window.reviewInjected = true</script>\n\n![remote](https://invalid.example/tracker.png)\n\n<<FILE:literal-reference>>\n\n[unsafe](javascript:alert(1))'));
  await page.getByRole('button', { name: '重新加载页面状态' }).click();
  const preview = card(page, 'a').locator('.tm-approval-preview');
  await expect(preview).toContainText('<<FILE:literal-reference>>');
  await expect(preview.locator('script, img, a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).reviewInjected)).toBeUndefined();
});

test('expired approval has no confirmation controls and remains expired after reload', async ({ page }) => {
  await mountApprovals(page);
  await page.evaluate(() => (window as any).approvalHarness.expire('a'));
  await page.getByRole('button', { name: '重新加载页面状态' }).click();
  await expect(card(page, 'a')).toHaveAttribute('data-status', 'expired');
  await expect(card(page, 'a').getByRole('button', { name: '确认这项修改' })).toHaveCount(0);
  await expect(card(page, 'b')).toHaveAttribute('data-status', 'pending');
});

test('failed approval retains actionable patch error and trace identifiers after reload', async ({ page }) => {
  await mountApprovals(page);
  await control(page, 'flags', { diagnostic: true });
  await card(page, 'b').getByRole('button', { name: '确认这项修改' }).click();
  await control(page, 'complete', { id: 'b', outcome: 'failed' });
  await expect(card(page, 'b')).toHaveAttribute('data-status', 'failed');
  await expect(card(page, 'b').getByRole('alert')).toContainText('补丁格式无效');
  await card(page, 'b').getByText('失败详情', { exact: true }).click();
  await expect(card(page, 'b')).toContainText('knowledge_edit_patch_invalid');
  await expect(card(page, 'b')).toContainText('HTTP 400');
  await expect(card(page, 'b')).toContainText('mcp-test-request');
  await expect(card(page, 'a')).toHaveAttribute('data-status', 'pending');
  await capture(page, 'failed-approval');
  await page.getByRole('button', { name: '重新加载页面状态' }).click();
  await card(page, 'b').getByText('失败详情', { exact: true }).click();
  await expect(card(page, 'b')).toContainText('knowledge-test-request');
  await expect(card(page, 'b').getByRole('button', { name: '确认这项修改' })).toHaveCount(0);
});

test('approval-owned task result survives reload when recent task reads are unavailable', async ({ page }) => {
  await mountApprovals(page);
  await control(page, 'flags', { diagnostic: true, inlineTasks: true, taskReadsFail: true });
  await card(page, 'b').getByRole('button', { name: '确认这项修改' }).click();
  await control(page, 'complete', { id: 'b', outcome: 'failed' });
  await expect(card(page, 'b')).toHaveAttribute('data-status', 'failed');
  await page.getByRole('button', { name: '重新加载页面状态' }).click();
  await expect(card(page, 'b')).toHaveAttribute('data-status', 'failed');
  await card(page, 'b').getByText('失败详情', { exact: true }).click();
  await expect(card(page, 'b')).toContainText('knowledge-test-request');
  await expect(page.getByText('执行结果暂时无法加载，将自动重试。')).toHaveCount(0);
});
