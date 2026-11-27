/**
 * create_background and create_species: the two halves of a character's
 * origin, each copied from its template into 5.5e / Backgrounds or
 * 5.5e / Species and filled field by field.
 *
 * Background template: image slot, description, a layout of four fields
 * (Ability Scores, Skill Proficiencies, Feat, Tool Proficiency), then
 * Equipment. Anything more a background has (a feature such as
 * "Conviction", a table of faction skills) follows the description. The
 * Feat field links the feat's article when one has that name, so a
 * background reads straight through to what it grants; when there is none,
 * the result says to create it.
 *
 * Species template: description, image slot, a layout of Type, Size and
 * Speed, then placeholder "Trait" sections, which are replaced by the
 * species' own traits as "#### <Trait>" sections.
 *
 * Tags are set in full, never merged with the template's: the Species
 * template carries "Human", which a merge would put on every species.
 */

import type { Block, LegendKeeperClient, Run } from "../lk/types";
import { composeBlocks, composeRuns } from "./compose";
import {
    createFilledCopy,
    fetchImage,
    findByName,
    findHome,
    findTemplate,
    heading,
    line,
    refuseTwin,
    RULES_ROOT,
    uniqueTags,
    type Created,
} from "./create";
import type { ResourceIndex } from "./index";

export interface BackgroundInput {
    name: string;
    source: string;
    description: string;
    /** Features and tables beyond the description, e.g. "#### Conviction" and its text. */
    details?: string;
    abilityScores: string;
    skillProficiencies: string;
    feat: string;
    toolProficiency?: string;
    equipment: string;
    tags: string[];
    imageUrl?: string;
    hidden: boolean;
    parentId?: string;
}

export async function createBackground(
    lk: LegendKeeperClient,
    index: ResourceIndex,
    input: BackgroundInput,
): Promise<Created> {
    const name = input.name.trim();
    const template = findTemplate(index, "Background");
    const parent = findHome(index, "Backgrounds", input.parentId);
    refuseTwin(index, "background", name, parent, "Background");

    const notes: string[] = [];
    const feat = featRuns(index, input.feat, notes);
    const image = input.imageUrl ? await fetchImage(input.imageUrl) : undefined;
    const tool = input.toolProficiency?.trim();

    const created = await createFilledCopy(lk, {
        template,
        name,
        parent,
        tags: uniqueTags(["Background", input.source, ...input.tags]),
        hidden: input.hidden,
        image,
        imageFolder: "Backgrounds",
        fill: (stored) => ({
            fields: {
                "Ability Scores": [line(input.abilityScores)],
                "Skill Proficiencies": [line(input.skillProficiencies)],
                Feat: [{ kind: "paragraph", content: feat }],
                "Tool Proficiency": tool ? [line(tool)] : null,
                Equipment: composeBlocks(input.equipment),
            },
            description: [...composeBlocks(input.description), ...composeBlocks(input.details ?? "")],
            image: stored,
        }),
    });
    return { id: created.id, notes: [...notes, ...created.notes] };
}

/**
 * The feat as a mention of its article when one has that name. A feat with
 * a choice in parentheses, "Magic Initiate (Cleric)", links the base name.
 */
function featRuns(index: ResourceIndex, feat: string, notes: string[]): Run[] {
    const text = feat.trim();
    const [, base, rest] = text.match(/^(.*?)(\s*\(.*\))?$/) ?? [, text, ""];
    const root = index.children(null).find((r) => r.name === RULES_ROOT);
    const folder = root && index.children(root.id).find((r) => r.name === "Feats");
    const feats = [...(folder ? index.inTreeOrder(folder.id) : []), ...index.withTags(["Feat"], "all")];
    const article = findByName(feats, base);
    if (!article) {
        notes.push(`No feat article is named "${base}"; the Feat field is plain text. Create it with create_feat to link it.`);
        return composeRuns(text);
    }
    return [{ mention: { resourceId: article.id, text: article.name } }, ...(rest ? [{ text: rest }] : [])];
}

export interface SpeciesInput {
    name: string;
    source: string;
    description: string;
    creatureType: string;
    size: string;
    speed: string;
    traits: { name: string; description: string }[];
    tags: string[];
    imageUrl?: string;
    hidden: boolean;
    parentId?: string;
}

export async function createSpecies(
    lk: LegendKeeperClient,
    index: ResourceIndex,
    input: SpeciesInput,
): Promise<Created> {
    const name = input.name.trim();
    const template = findTemplate(index, "Species");
    const parent = findHome(index, "Species", input.parentId);
    refuseTwin(index, "species", name, parent, "Species");

    const image = input.imageUrl ? await fetchImage(input.imageUrl) : undefined;
    const traits: Block[] = input.traits.flatMap((trait) => [
        heading(2, trait.name.trim()),
        ...composeBlocks(trait.description),
    ]);

    return createFilledCopy(lk, {
        template,
        name,
        parent,
        tags: uniqueTags(["Species", name, input.source, input.creatureType, ...input.tags]),
        hidden: input.hidden,
        image,
        imageFolder: "Species",
        fill: (stored) => ({
            fields: {
                Type: [line(input.creatureType)],
                Size: [line(input.size)],
                Speed: [line(input.speed)],
            },
            description: composeBlocks(input.description),
            image: stored,
            placeholder: (block) =>
                block.kind === "heading" && block.content.map((run) => ("text" in run ? run.text : "")).join("").trim() === "Trait",
            tail: traits,
        }),
    });
}
