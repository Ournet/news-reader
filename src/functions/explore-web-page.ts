
import { fetchUrl } from './fetch-url';
import { extractTextFromHtml } from '../helpers';
import { sanitizeNewsText, sanitizeNewsTitle } from './sanitizer';
import { normalizeUrl } from '@ournet/domain';
const metascraper = require('metascraper');
const ascrape = require('ascrape');

export async function exploreWebPage(webpageUrl: string, lang: string, extractContent?: boolean) {
    const { body: html, url } = await fetchUrl(webpageUrl, {
        timeout: 1000 * 3,
        headers: {
            'user-agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)',
            // 'user-agent': 'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36',
            // 'cache-control': 'max-age=0',
            'accept': 'text/html,application/xhtml+xml',
            // 'accept-charset': 'utf8',
            // 'accept-encoding': 'gzip, deflate',
        },
    });

    const metadata = await metascraper({ html, url });
    let text: string | undefined;
    if (extractContent !== false) {
        const content = await scrapeArticleContent(html);
        if (content) {
            text = sanitizeNewsText(extractTextFromHtml(content), lang);
        }
    }

    const webpage: WebPage = {
        title: metadata.title && sanitizeNewsTitle(extractTextFromHtml(metadata.title), lang),
        url: normalizeWebPageUrl(metadata.url || url),
        image: metadata.image,
        video: metadata.video,
        description: metadata.description && sanitizeNewsTitle(extractTextFromHtml(metadata.description), lang),
        text,
    };

    return webpage;
}

function normalizeWebPageUrl(url: string) {
    return normalizeUrl(url, {
        normalizeProtocol: true,
        normalizeHttps: undefined,
        normalizeHttp: false,
        stripFragment: true,
        stripWWW: undefined,
        removeTrailingSlash: false,
        sortQueryParameters: false,
    });
}

function scrapeArticleContent(html: string) {
    return new Promise<string | undefined>((resolve, reject) => {
        ascrape(html, (error: Error, article: any) => {
            if (error) {
                return reject(error);
            }
            if (article.content) {
                resolve(article.content.html());
            } else {
                resolve();
            }
        });
    });
}

export type WebPage = {
    title: string
    url: string
    description?: string
    image?: string
    video?: string
    lang?: string
    text?: string
}
