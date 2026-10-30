import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {fileRichText} from './fileRichText.ts';

const flatten=nodes=>nodes.flatMap(node=>[node,...('children' in node?flatten(node.children):[])]);
const text=nodes=>flatten(nodes).filter(node=>node.type==='text').map(node=>node.text).join('');

describe('HTML and Markdown document reading',()=>{
  it('renders a full HTML document with Chinese text, headings, lists and tables',()=>{
    const {nodes}=fileRichText('<!doctype html><html><head><title>hidden title</title></head><body><h1>季度报告 &amp; 分析</h1><p style="color:#123456;text-align:center">正文</p><table><tr><th>项目</th><th>收益</th></tr><tr><td colspan="2">12%</td></tr></table><ul><li>下一步</li></ul></body></html>','html');
    const all=flatten(nodes);assert.equal(nodes[0].name,'h1');assert.match(text(nodes),/季度报告 & 分析正文项目收益12%下一步/);assert(!text(nodes).includes('hidden title'));
    assert.match(all.find(node=>node.name==='p').attrs.style,/color:#123456;text-align:center/);
    assert.equal(all.find(node=>node.name==='td').attrs.colspan,'2');
  });
  it('removes executable elements, events and active CSS while keeping the document',()=>{
    const {nodes}=fileRichText('<script>steal()</script><style>body{display:none}</style><iframe src="https://bad.test"></iframe><form>hidden form</form><p onclick="steal()" style="color:red;background:url(https://bad.test/x);width:expression(steal());position:fixed">保留</p><a href="javascript:steal()">链接</a>','html');
    const all=flatten(nodes);assert.equal(text(nodes),'保留链接');assert(all.every(node=>!['script','style','iframe','form'].includes(node.name)));
    assert.equal(all.find(node=>node.name==='p').attrs.style,'margin:12px 0;color:red');
    assert.equal(all.find(node=>node.name==='a').attrs.href,undefined);assert.equal(JSON.stringify(nodes).includes('steal'),false);
  });
  it('supports Markdown tables, code, emphasis and images without treating embedded HTML as code',()=>{
    const {nodes}=fileRichText('# 报告\n\n**重点**\n\n|项目|收益|\n|---|---|\n|组合|12%|\n\n```js\nconst x = "<script>";\n```\n\n![图](https://example.com/chart.png)\n\n<script>alert(1)</script>','markdown');
    const all=flatten(nodes);for(const name of ['h1','strong','table','pre','code','img'])assert(all.some(node=>node.name===name),name);
    assert(text(nodes).includes('<script>alert(1)</script>'));assert(!all.some(node=>node.name==='script'));
  });
  it('keeps image alt text when the source is relative, executable or carries credentials',()=>{
    const {nodes}=fileRichText('<img src="javascript:bad()" alt="A"><img src="./private.png" alt="B"><img src="https://user:password@example.com/x" alt="C"><img src="https://example.com/ok.png" onerror="bad()" style="width:3000px">','html');
    assert.equal(text(nodes),'[A][B][C]');const image=flatten(nodes).find(node=>node.name==='img');
    assert.equal(image.attrs.src,'https://example.com/ok.png');assert.equal(image.attrs.onerror,undefined);assert.match(image.attrs.style,/max-width:100%;height:auto;$/);
  });
  it('renders remote images without relying on browser URL globals',()=>{
    const original=globalThis.URL;
    try {
      globalThis.URL=undefined;
      const {nodes}=fileRichText('![图](https://example.com/chart.png)','markdown');
      assert.equal(flatten(nodes).find(node=>node.name==='img').attrs.src,'https://example.com/chart.png');
    } finally {globalThis.URL=original;}
  });
  it('bounds rich-text nodes and nesting for large generated reports',()=>{
    const many=fileRichText('<p>row</p>'.repeat(5000),'html');assert(many.truncated);assert(flatten(many.nodes).length<=4000);
    const deep=fileRichText('<div>'.repeat(100)+'deep'+'</div>'.repeat(100),'html');assert(deep.truncated);
  });
});
