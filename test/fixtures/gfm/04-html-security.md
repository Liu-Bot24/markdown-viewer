# 原生 HTML 与安全过滤

<details>
<summary>点击展开 <b>details</b></summary>

折叠内容中的 **Markdown**。

</details>

<p align="right">右对齐段落</p>

<script>window.__pwned = 1; alert('xss')</script>

<img src="x" onerror="window.__pwned = 2">

<a href="javascript:window.__pwned=3">javascript 链接</a>

[markdown javascript 链接](javascript:window.__pwned=4)

<iframe src="https://example.com"></iframe>

<style>body { display: none !important; }</style>

<form action="https://example.com"><input type="text" name="q"><button>提交</button></form>

<svg width="40" height="40"><circle cx="20" cy="20" r="15" fill="tomato" onclick="window.__pwned=5"/><script>window.__pwned=6</script></svg>

<div onclick="window.__pwned=7" style="color: green">内联样式保留，事件属性去掉</div>

<input type="checkbox" checked> 原始 HTML 复选框（只读）

<video src="javascript:alert(1)" autoplay></video>

<object data="x.swf"></object><embed src="x.swf">

<math><mi>x</mi><mo>+</mo><mn>1</mn></math>

正常文本结束。
