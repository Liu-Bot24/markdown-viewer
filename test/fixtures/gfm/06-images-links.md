# 图片与链接路径

## 图片

普通相对路径：![plain](assets/plain.png)

中文和空格路径（尖括号）：![示例](<assets/图片 目录/示例 图片.png>)

中文和空格路径（百分号编码）：![示例2](assets/%E5%9B%BE%E7%89%87%20%E7%9B%AE%E5%BD%95/%E7%A4%BA%E4%BE%8B%20%E5%9B%BE%E7%89%87.png)

emoji 目录：![emoji](<assets/🍎 emoji 目录/pic.png>)

带标题：![plain titled](assets/plain.png "图片标题")

缺失图片（应显示占位而不是破图标）：![missing](assets/does-not-exist.png)

HTML 图片：<img src="assets/plain.png" width="80" alt="html img">

网络图片（离线时显示占位）：![remote](https://www.gstatic.com/images/branding/product/1x/googleg_48dp.png)

## 链接

- [同目录文档](other.md)
- [文档加锚点](other.md#第二节)
- [尖括号带空格和锚点](<sub#dir/inner file.md#目标-标题>)
- [本文锚点](#链接)
- [中文标题锚点](#图片与链接路径)
- [不存在的文件](no-such-file.md)
- [文件夹链接](assets/)
- [媒体链接：图片](<assets/图片 目录/示例 图片.png>)
- [外部链接](https://example.com/?a=1&b=2)
- [邮件](mailto:someone@example.com)
