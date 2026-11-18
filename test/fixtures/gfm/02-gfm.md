# GFM 扩展

## 表格

| 左对齐 | 居中 | 右对齐 | 代码 |
| :--- | :---: | ---: | --- |
| a | b | 1.00 | `x \| y` |
| 中文内容 | **粗** | 22.5 | [链接](https://example.com) |
| 转义 \| 竖线 | ~~删除~~ | 333 | |

宽表格（应可横向滚动，不撑破版面）：

| 时间 | 会话 | 谁 | 什么事 | 要我做什么 | 备注一 | 备注二 | 备注三 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 09-01 10:03 | 一个名字非常非常长的群聊名称用于测试换行行为 | 测试甲 | 一段用来测试表格换行的较长说明文字，没有实际含义。 | 无 | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb | cccccccccccccccccccccccccccc |

不是表格（缺少分隔行）：
| a | b |
| c | d |

## 任务列表

- [ ] 未完成任务 **加粗**
- [x] 已完成任务
- [X] 大写 X 也算完成
  - [ ] 嵌套任务
- 普通列表项
- [ ]不是任务（缺空格）

1. [ ] 有序任务列表
2. [x] 第二项

## 删除线

~~单行删除~~，~删除线单波浪~，~~跨 *强调* 删除~~。

## 自动链接

www.example.com、https://example.com/path_(with)_parens、http://中文.example/路径?a=1&b=2、foo@bar.example.com。

文件名不应变成链接：readme.md、月报_2026-09.md、archive.tar.gz、图片.png。

URL 后的中文标点：请访问 https://example.com/a。然后继续。

## 脚注

正文引用脚注[^1]，再引用一个命名脚注[^note]，重复引用[^1]。

[^1]: 第一个脚注。
[^note]: 命名脚注，含 **格式** 和 `代码`。

## 提示块

> [!NOTE]
> 这是 NOTE 提示。

> [!WARNING]
> 这是 WARNING 提示。

> [!CAUTION]
> 危险提示。
