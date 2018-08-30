
const debug = require('debug')('ournet:news-reader:event');

import {
    NewsItem,
    NewsEvent,
    Topic,
    EventHelper,
    ArticleContentRepository,
    ArticleContentBuilder,
    NewsEventItem,
} from "@ournet/news-domain";
import { uniq, Dictionary } from "@ournet/domain";
import { logger } from "../logger";
import { isLetter, inTextSearch } from "../helpers";
import { ImageHelper, ImageRepository } from "@ournet/images-domain";
import { DataService } from "../services/data-service";

const MIN_TITLE_LENGTH = 25;
const MAX_TITLE_LENGTH = 140;
const MIN_IMAGE_WIDTH = 460;

export type CreateEventOptions = {
    minSearchScore: number
    minEventNews: number
}

export async function createEvent(dataService: DataService, newsItem: NewsItem, options: CreateEventOptions): Promise<NewsEvent | undefined> {

    const maxCreatedAt = new Date();
    maxCreatedAt.setHours(maxCreatedAt.getHours() - 12);

    const q = newsItem.title;

    const foundedNews = await dataService.newsRep.search({
        country: newsItem.country,
        lang: newsItem.lang,
        minScore: options.minSearchScore,
        limit: 10,
        maxCreatedAt,
        q,
        type: 'best_fields',
    });

    if (!foundedNews.length) {
        debug(`Not found news for: ${q}`);
        return
    }

    const newsWithoutEvent: NewsItem[] = [];
    const newsWithEvent: NewsItem[] = [];

    foundedNews.forEach(item => {
        if (item.eventId) {
            newsWithEvent.push(item);
        } else {
            newsWithoutEvent.push(item);
        }
    });

    let event: NewsEvent | undefined;
    if (newsWithEvent.length) {
        event = await addNewsToEvent(dataService, newsWithEvent[0].eventId as string, newsItem);
    } else if (newsWithoutEvent.length + 1 >= options.minEventNews) {
        newsWithoutEvent.unshift(newsItem);
        event = await createNewsEvent(dataService, newsWithoutEvent);
    }

    return event;
}

async function createNewsEvent(dataService: DataService, newsItems: NewsItem[]) {
    debug(`Creating event...`);
    const title = findBestEventTitle(newsItems) as string;
    if (!title) {
        logger.warn(`Not found a goot event title`);
        return;
    }



    const allTopics = newsItems.reduce<Topic[]>((list, item) => list.concat(item.topics || []), []);
    const topics = extractEventTopics(allTopics, 5, 2);

    if (!topics.length || topics.length < 2) {
        logger.warn(`No topics for the news creating event: ${title}`);
        return;
    }

    const eventImage = await findBestEventImage(dataService.imageRep, newsItems);
    if (!eventImage) {
        logger.warn(`Not found image for event ${title}`);
        return;
    }

    const contentItem = await findEventContentItem(dataService.articleContentRep, newsItems);
    if (!contentItem) {
        logger.warn(`Not found content for event ${title}`);
        return;
    }


    const summary = findBestEventSummary(title, newsItems);
    const { imagesIds, quotesIds, videosIds } = formatEventLists(newsItems);

    let items = newsItems.filter(item => item.title.length > MIN_TITLE_LENGTH && item.title.length < MAX_TITLE_LENGTH);
    if (items.length < 3) {
        items = items.concat(newsItems).slice(0, 3);
    }


    const country = items[0].country;
    const lang = items[0].lang;

    const event = EventHelper.build({
        title,
        summary,
        topics,
        countImages: imagesIds.length,
        quotesIds,
        videosIds,
        country,
        lang,
        hasContent: true,
        imageHost: eventImage.host,
        imageId: eventImage.id,
        imageSourceId: eventImage.sourceId,
        news: items.map(mapNewsItemToEventNewsItem),
        source: {
            host: contentItem.host,
            path: contentItem.path,
            id: contentItem.id,
            sourceId: contentItem.sourceId,
        },
    });

    await dataService.articleContentRep.create(ArticleContentBuilder.build({
        content: contentItem.content,
        refId: event.id,
        refType: 'EVENT',
    }));

    const createdEvent = await dataService.eventRep.create(event);

    await Promise.all(newsItems.map(item => dataService.newsRep.update({ id: item.id, set: { eventId: event.id } })));

    debug(`Created event: ${title}`);

    return createdEvent;
}

async function addNewsToEvent(dataService: DataService, eventId: string, newsItem: NewsItem) {
    const event = await dataService.eventRep.getById(eventId);

    if (!event) {
        throw new Error(`Not found event=${eventId}`);
    }

    await dataService.newsRep.update({
        id: newsItem.id,
        set: {
            eventId,
        }
    });

    const eventNews = await dataService.newsRep.latestByEvent({ eventId, country: event.country, lang: event.lang, limit: event.countNews + 2 },
        { fields: ['id', 'imageIds', 'quotesIds', 'videoId'] });

    const { imagesIds, quotesIds, videosIds } = formatEventLists(eventNews);


    const setEvent: Partial<NewsEvent> = {
        countNews: event.countNews + 1,
        countImages: imagesIds.length,
        countQuotes: quotesIds.length,
        countVideos: videosIds.length,
        quotesIds,
        videosIds,
    };

    if (event.items.length < 6 && newsItem.title.length > MIN_TITLE_LENGTH && newsItem.title.length < MAX_TITLE_LENGTH) {
        event.items.push(mapNewsItemToEventNewsItem(newsItem));
        setEvent.items = event.items;
    }

    const updatedEvent = await dataService.eventRep.update({
        id: eventId,
        set: setEvent,
    });

    debug(`Updated event: ${event.title}`);

    return updatedEvent;
}

async function findEventContentItem(contentRep: ArticleContentRepository, newsItems: NewsItem[]) {

    const contentItem = newsItems.find(item => item.hasContent);
    if (!contentItem) {
        return;
    }

    const content = await contentRep.getById(ArticleContentBuilder.createId({ refId: contentItem.id, refType: 'NEWS' }));
    if (!content) {
        return;
    }

    return {
        id: contentItem.id,
        host: contentItem.urlHost,
        path: contentItem.urlPath,
        sourceId: contentItem.sourceId,
        content: content.content,
    }
}

async function findBestEventImage(imageRep: ImageRepository, newsItems: NewsItem[]) {
    const imageItems = newsItems.filter(item => item.imageIds && item.imageIds.length
        && ImageHelper.parseImageOrientationFromId(item.imageIds[0]) === 'LANGSCAPE');

    if (!imageItems.length) {
        return;
    }

    const ids = uniq(imageItems.reduce<string[]>((list, item) => list.concat(item.imageIds || []), []));

    const images = await imageRep.getByIds(ids);

    const image = images.sort((a, b) => b.width - a.width)[0];

    if (image.width < MIN_IMAGE_WIDTH) {
        return;
    }

    const item = imageItems.find(item => item.imageIds && item.imageIds.includes(image.id) || false);
    if (!item) {
        logger.error(`Not found item by image id!!!`);
        return;
    }

    return {
        host: item.urlHost,
        sourceId: item.sourceId,
        id: image.id,
    }
}

function formatEventLists(newsItems: NewsItem[]) {
    let imagesIds: string[] = [];
    let quotesIds: string[] = [];
    let videosIds: string[] = [];

    newsItems.forEach(item => {
        if (item.imageIds) {
            imagesIds = imagesIds.concat(item.imageIds);
        }
        if (item.videoId) {
            videosIds.push(item.videoId);
        }
        if (item.quotesIds) {
            quotesIds = quotesIds.concat(item.quotesIds);
        }
    });

    imagesIds = uniq(imagesIds);
    quotesIds = uniq(quotesIds);
    videosIds = uniq(videosIds);

    return {
        imagesIds,
        quotesIds,
        videosIds,
    }
}

function findBestEventSummary(title: string, newsItems: NewsItem[]) {
    const search = inTextSearch(title);

    const data = newsItems.map(item => ({ summary: item.summary, score: search(item.summary) }))
        .sort((a, b) => b.score - a.score);

    debug(`select summary from`, data);

    return data[0].summary;
}

function findBestEventTitle(newsItems: NewsItem[]) {
    const titles = newsItems.map(item => item.title)
        .filter(title => title.length > MIN_TITLE_LENGTH && title.length < MAX_TITLE_LENGTH);
    if (!titles.length) {
        return;
    }
    if (titles.length === 1) {
        return titles[0];
    }

    const titlesData = titles.map(title => {
        let score = 0;
        for (const char of title) {
            if (['.', '?', '!', '(', ')', '[', ']', '{', '}', ';'].includes(char)) {
                score--;
            }
            else if (isLetter(char) && char.toUpperCase() === char) {
                score--;
            }
        }

        return {
            score, title,
        }
    }).sort((a, b) => b.score - a.score);

    debug(`select 1st from titles`, titlesData);

    return titlesData[0].title;
}

function extractEventTopics(topics: Topic[], limit: number, minScore: number = 2) {
    minScore = minScore && minScore > 0 ? minScore : 2;

    const topicsMap = topics.reduce<Dictionary<{ score: number, topic: Topic }>>((map, topic) => {
        if (!map[topic.id]) {
            map[topic.id] = { score: 0, topic };
        }
        map[topic.id].score++;
        return map;
    }, {});

    return Object.keys(topicsMap)
        .map(id => topicsMap[id])
        .filter(item => item.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(item => item.topic);
}

function mapNewsItemToEventNewsItem(item: NewsItem) {
    const eventItem: NewsEventItem = {
        host: item.urlHost,
        id: item.id,
        path: item.urlPath,
        publishedAt: item.publishedAt,
        sourceId: item.publishedAt,
        title: item.title,
    }

    return eventItem;
}