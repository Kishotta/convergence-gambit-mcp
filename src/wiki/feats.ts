/**
 * create_feat — a feat article in 5.5e / Feats. There is no Feat template,
 * so the article is written whole, in one request.
 *
 * The page opens the way the 2024 rules print a feat, with its category
 * and any prerequisite in italics ("General Feat (Prerequisite: Level 4+)"),
 * then the benefit text, tables included. Tags: "Feat", the category as
 * "<Category> Feat" (so "Origin Feat" gathers what a background can grant),
 * the source, and "Repeatable" when it is.
 */

import type { Block, LegendKeeperClient } from "../lk/types";
import { composeBlocks, composeRuns } from "./compose";
import { createWhole, fetchImage, findHome, refuseTwin, uniqueTags, type Created } from "./create";
import type { ResourceIndex } from "./index";

const HOME_FOLDER = "Feats";
const FEAT_TAG = "Feat";

export const FEAT_CATEGORIES = {
    origin: "Origin",
    general: "General",
    fightingStyle: "Fighting Style",
    epicBoon: "Epic Boon",
} as const;
export type FeatCategory = keyof typeof FEAT_CATEGORIES;

export interface FeatInput {
    name: string;
    category: FeatCategory;
    prerequisite?: string;
    repeatable: boolean;
    description: string;
    source?: string;
    tags: string[];
    imageUrl?: string;
    hidden: boolean;
    parentId?: string;
}

export async function createFeat(lk: LegendKeeperClient, index: ResourceIndex, input: FeatInput): Promise<Created> {
    const name = input.name.trim();
    const parent = findHome(index, HOME_FOLDER, input.parentId);
    refuseTwin(index, "feat", name, parent, FEAT_TAG);

    const image = input.imageUrl ? await fetchImage(input.imageUrl) : undefined;
    const category = `${FEAT_CATEGORIES[input.category]} Feat`;
    const prerequisite = input.prerequisite?.trim();

    return createWhole(lk, {
        name,
        parent,
        tags: uniqueTags([FEAT_TAG, category, input.source, input.repeatable && "Repeatable", ...input.tags]),
        hidden: input.hidden,
        image,
        imageFolder: HOME_FOLDER,
        documents: (stored) => [
            {
                name: "Main",
                blocks: [
                    ...(stored
                        ? [{ kind: "image", url: stored.url, alt: stored.alt, title: "Image", isTitleHidden: true, layout: "wrapRight", width: 40 } as Block]
                        : []),
                    {
                        kind: "paragraph",
                        content: composeRuns(
                            prerequisite ? `${category} (Prerequisite: ${prerequisite})` : category,
                            { italic: true },
                        ),
                    },
                    ...composeBlocks(input.description),
                ],
            },
        ],
    });
}
