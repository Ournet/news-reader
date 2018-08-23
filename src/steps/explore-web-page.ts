
import { fetchUrl } from '../fetch-url';
import { extractTextFromHtml } from '../helpers';
import { sanitizeNewsText, sanitizeNewsTitle } from '../sanitizer';
const metascraper = require('metascraper');
const ascrape = require('ascrape');

export async function exploreWebPage(webpageUrl: string) {
    const { body: html, url } = await fetchUrl(webpageUrl, {
        timeout: 1000 * 3,
        headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36',
            'cache-control': 'max-age=0',
            'accept': 'text/html,application/xhtml+xml',
            'accept-charset': 'utf8',
        },
    });

    const metadata = await metascraper({ html, url });
    const content = await scrapeArticleContent(html);
    let text: string | undefined;
    if (content) {
        text = sanitizeNewsText(extractTextFromHtml(content));
    }

    const webpage: WebPage = {
        title: metadata.title && sanitizeNewsTitle(extractTextFromHtml(metadata.title)),
        url: metadata.url || url,
        image: metadata.image,
        video: metadata.video,
        description: metadata.description && sanitizeNewsTitle(extractTextFromHtml(metadata.description)),
        text,
    };

    return webpage;
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
