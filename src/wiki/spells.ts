/**
 * create_spell — a spell article in 5.5e / Spells, from the Spell template.
 *
 * The template's infobox holds the stats (Level, Damage/Effect, Casting
 * Time, Duration, Range/Area, Attack/Save), the description replaces its
 * placeholder, "At Higher Levels" is its own text field (removed when the
 * spell has none), and a material component gets a "Material Components"
 * text field at the end, as the existing spells have it.
 *
 * Tags do the integrating. Each class's Spell List tab is a collection of
 * everything tagged both "Spell" and the class's name, so tagging a spell
 * with its classes is what puts it on their lists. A class name is matched
 * to the class article's own spelling; a class with no article yet is still
 * tagged, and the result says so. The template's own tags (all three
 * components) are replaced, never merged, so a spell is tagged only with the
 * components it has.
 */

import type { LegendKeeperClient } from "../lk/types";
import { composeBlocks } from "./compose";
import {
    createFilledCopy,
    findByName,
    findHome,
    findTemplate,
    line,
    refuseTwin,
    uniqueTags,
    type Created,
} from "./create";
import type { ResourceIndex } from "./index";

const TEMPLATE = "Spell";
const HOME_FOLDER = "Spells";
const SPELL_TAG = "Spell";

export const SCHOOLS = [
    "Abjuration",
    "Conjuration",
    "Divination",
    "Enchantment",
    "Evocation",
    "Illusion",
    "Necromancy",
    "Transmutation",
] as const;
export type School = (typeof SCHOOLS)[number];

export interface SpellInput {
    name: string;
    /** 0 for a cantrip. */
    level: number;
    school: School;
    classes: string[];
    castingTime: string;
    range: string;
    duration: string;
    verbal: boolean;
    somatic: boolean;
    /** The material component's text; present means the spell has one. */
    material?: string;
    damageEffect?: string;
    attackSave?: string;
    ritual: boolean;
    concentration: boolean;
    description: string;
    higherLevels?: string;
    source?: string;
    tags: string[];
    hidden: boolean;
    parentId?: string;
}

export async function createSpell(lk: LegendKeeperClient, index: ResourceIndex, input: SpellInput): Promise<Created> {
    const name = input.name.trim();
    const template = findTemplate(index, TEMPLATE);
    const parent = findHome(index, HOME_FOLDER, input.parentId);
    refuseTwin(index, "spell", name, parent, SPELL_TAG);

    const notes: string[] = [];
    const classArticles = index.withTags(["Class"], "all");
    const classes = input.classes.map((wanted) => {
        const article = findByName(classArticles, wanted);
        if (!article) {
            notes.push(
                `No class article is named "${wanted.trim()}" yet. The spell is tagged with it anyway, ` +
                    "so it joins that class's Spell List once the class exists.",
            );
        }
        return article?.name ?? wanted.trim();
    });

    const material = input.material?.trim();
    const higherLevels = input.higherLevels?.trim();

    const created = await createFilledCopy(lk, {
        template,
        name,
        parent,
        tags: uniqueTags([
            SPELL_TAG,
            input.verbal && "Verbal",
            input.somatic && "Somatic",
            material && "Material",
            input.school,
            ...classes,
            input.ritual && "Ritual",
            input.concentration && "Concentration",
            input.source,
            ...input.tags,
        ]),
        hidden: input.hidden,
        imageFolder: HOME_FOLDER,
        fill: () => ({
            fields: {
                Level: [line(levelLabel(input.level))],
                "Damage/Effect": [line(input.damageEffect ?? "")],
                "Casting Time": [line(input.castingTime)],
                Duration: [line(input.duration)],
                "Range/Area": [line(input.range)],
                "Attack/Save": [line(input.attackSave ?? "")],
                "At Higher Levels": higherLevels ? composeBlocks(higherLevels) : null,
                "Material Components": material ? [line(material)] : null,
            },
            optional: ["Material Components"],
            description: composeBlocks(input.description),
        }),
    });
    return { id: created.id, notes: [...notes, ...created.notes] };
}

/** "Cantrip", "1st", "2nd", "3rd", "4th" … as the existing spells write it. */
export function levelLabel(level: number): string {
    if (level === 0) return "Cantrip";
    return `${level}${level === 1 ? "st" : level === 2 ? "nd" : level === 3 ? "rd" : "th"}`;
}
