import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { PDFParse } from 'pdf-parse'
import * as cheerio from 'cheerio'

/**
 * 实际开发中的典型应用场景：
 *
 *  1、读取文件：FileReader 读取到的 ArrayBuffer，必须用 Uint8Array 才能按字节操作。
 *  2、网络请求：fetch 获取 response.arrayBuffer() 后，转为 Uint8Array 来解析图片、音频或自定义协议数据。
 *  3、操作底层二进制：在处理加密、压缩、图片处理时，用它来直接操控二进制流。
 */

/**
 * 加载后的文档结构
 */
export interface LoadedDocument {
  content: string // 文档文本内容
  metadata: Record<string, any> // 文档元数据
}

/**
 * 文档加载服务
 *
 * 职责：
 * 1. 从不同来源加载文档（文件、URL）
 * 2. 解析不同格式的文件（PDF、TXT、MD、CSV、HTML、JSON）
 * 3. 提取纯文本内容和元数据
 * 4. 统一返回 LoadedDocument 格式
 *
 * 支持的文件格式：
 * - PDF: 使用 pdf-parse 提取文本和元数据（页码、作者等）
 * - TXT/MD/CSV: 直接读取为文本
 * - HTML: 使用 cheerio 解析，移除脚本、样式等噪声
 * - JSON: 支持多种 JSON 结构
 * - URL: 自动识别 HTML 或纯文本
 */

@Injectable()
export class DocumentLoaderService {
  private readonly logger = new Logger(DocumentLoaderService.name)

  /**
   * 根据文件类型加载文档，提取纯文本
   *
   * @param buffer - 文件二进制数据
   * @param originalName - 原始文件名（用于判断格式）
   * @param mimeType - MIME 类型
   * @returns 文档数组（一个文件可能解析为多个文档）
   */
  async loadFile(buffer: Buffer, originalName: string, mimeType: string): Promise<LoadedDocument[]> {
    const ext = this.getExtension(originalName)
    this.logger.log(`Loading file: ${originalName} (${mimeType}, ${buffer.length} bytes)`)

    switch (ext) {
      case '.pdf':
        return this.loadPdf(buffer, originalName)
      case '.txt':
      case '.md':
      case '.csv':
        return this.loadTxt(buffer, originalName, ext)
      case '.html':
      case '.htm':
        return this.loadHtml(buffer, originalName)
      case '.json':
        return this.loadJson(buffer, originalName)
      default:
        throw new BadRequestException(`暂不支持的文件类型：${ext}, 目前仅支持 PDF、TXT、MD、CSV、HTML、JSON`)
    }
  }

  /**
   * 从 URL 加载网页内容
   *
   * @param url - 网页 URL
   * @returns 文档数组
   *
   * 流程：
   * 1. 发送 HTTP 请求获取内容
   * 2. 根据 Content-Type 判断格式
   * 3. HTML 内容使用 cheerio 解析提取正文
   * 4. 纯文本直接返回
   */
  async loadUrl(url: string): Promise<LoadedDocument[]> {
    this.logger.log(`Loading URL: ${url}`)
    try {
      // Remark: `https://example.com` 需要换成真实的
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; KnowledgeBaseBot/1.0; +https://example.com)',
          Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
        },
        signal: AbortSignal.timeout(30000),
      })

      if (!response.ok) {
        throw new BadRequestException(`无法获取网页内容： HTTP ${response.status}`)
      }

      const contentType = response.headers.get('content-type') || ''
      const contentBody = await response.text()

      // 判断是否为 HTML
      if (contentType.includes('text/html') || contentType.includes('xhtml')) {
        return this.parseHtml(contentBody, url)
      }

      // 其他类型作为纯文本处理
      const callback_res = [
        {
          content: contentBody.trim(),
          metadata: {
            source: url,
            type: 'url',
            contentType,
          },
        },
      ]
      return Promise.resolve(callback_res)
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error
      throw new BadRequestException(`加载网页失败：${error?.message}`)
    }
  }

  /**
   * 解析pdf
   *
   * 使用 pdf-parse 库提取：
   * - 文本内容
   * - 页码数
   * - 元数据（作者、标题等
   */
  private async loadPdf(buffer, fileName): Promise<LoadedDocument[]> {
    try {
      const parser = new PDFParse(buffer)
      const textResult = await parser.getText()
      if (!textResult.text || textResult.text.trim().length === 0) {
        throw new BadRequestException('PDF 文件中未提取到文本内容')
      }
      this.logger.log(`
        PDF parsed: ${textResult.total} pages, ${textResult.text.length} chars
      `)

      const info = await parser.getInfo().catch(() => null) // 尝试获取元数据，失败也不影响
      await parser.destroy() // 立即释放资源，防止内存、句柄泄漏

      return Promise.resolve([
        {
          content: textResult.text,
          metadata: {
            source: fileName,
            type: 'pdf',
            pages: textResult.total,
            ...(info?.info ? { info: info?.info } : {}),
          },
        },
      ])
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error
      throw new BadRequestException(`PDF 解析失败: ${error.message}`)
    }
  }

  /**
   * 解析txt、md、csv
   */
  private async loadTxt(buffer: Buffer, fileName: string, ext: string): Promise<LoadedDocument[]> {
    const content = buffer.toString('utf-8').trim()
    if (!content) {
      throw new BadRequestException(`文件内容为空`)
    }
    const callback_res = [
      {
        content,
        metadata: {
          source: fileName,
          type: ext.replace('.', ''),
        },
      },
    ]
    return Promise.resolve(callback_res)
  }

  /**
   * 解析html
   */
  private async loadHtml(buffer: Buffer, fileName: string): Promise<LoadedDocument[]> {
    const htmlContent = buffer.toString('utf-8')
    return this.parseHtml(htmlContent, fileName)
  }
  /**
   * 解析 HTML 内容，从html content中提取 html文本内容
   *
   * 清理策略：
   * 1. 移除脚本、样式、导航、页脚等非内容元素
   * 2. 优先提取 article、main 等语义标签
   * 3. 提取页面标题
   */
  private async parseHtml(htmlContent: string, fileName: string): Promise<LoadedDocument[]> {
    const $ = cheerio.load(htmlContent)

    // 移除不需要的标签
    $('script, style, nav, footer, header, aside, iframe, noscript').remove()

    // 提取标题
    const title = $('title').text().trim() || $('h1').first().text().trim()

    // 提取主要内容（优先 article/main/app，否则body）
    let mainContent = ''
    const mainEl = $('article, main, [role="main"], [id="app"]').first()
    if (mainEl.length) {
      mainContent = mainEl.text()
    } else {
      mainContent = $('body').text()
    }

    // 清理多余的空白
    const content = mainContent.replace(/\s+/g, ' ').trim()

    if (!content) {
      throw new BadRequestException(`网页中未提取到有效的文本内容`)
    }

    const callback_res = [
      {
        content,
        metadata: {
          source: fileName,
          type: 'html',
          title,
        },
      },
    ]

    return Promise.resolve(callback_res)
  }

  /**
   * 解析json
   *
   * 支持多种 JSON 格式：
   * 1. 字符串数组：["内容1", "内容2"]
   * 2. 文档对象数组：[{content: "内容", metadata: {}}]
   * 3. 带文档字段的对象：{documents: [...]}
   * 4. 单个文档：{content: "内容", metadata: {}}
   */
  private async loadJson(buffer: Buffer, fileName: string): Promise<LoadedDocument[]> {
    try {
      const text = buffer.toString('utf-8')
      const json = JSON.parse(text)

      let docs: LoadedDocument[] = []

      if (Array.isArray(json)) {
        // 数组格式
        docs = json.map((item) => ({
          content: typeof item === 'string' ? item : item?.content,
          metadata: {
            source: fileName,
            type: 'json',
            ...(item?.metadata || {}),
          },
        }))
      } else if (json.documents && Array.isArray(json.documents)) {
        // 带 documents 字段的对象
        docs = json.documents.map((item) => ({
          content: item?.content,
          metadata: {
            source: fileName,
            type: 'json',
            ...(item?.metadata || {}),
          },
        }))
      } else if (json.content) {
        // 单个文档对象
        docs = [
          {
            content: json.content,
            metadata: {
              source: fileName,
              type: 'json',
              ...(json?.metadata || {}),
            },
          },
        ]
      } else {
        throw new Error('不支持的 JSON 格式')
      }
      if (docs.length === 0 || docs.some((item) => !item.content)) {
        throw new Error('JSON 中没有有效的文档内容')
      }

      return Promise.resolve(docs)
    } catch (error: any) {
      throw new BadRequestException(`JSON 解析失败：${error.message}`)
    }
  }

  /**
   * 根据文件名提取文件扩展名
   */
  private getExtension(fileName: string): string {
    const idx = fileName.lastIndexOf('.')
    return idx >= 0 ? fileName.slice(idx).toLowerCase() : ''
  }
}
