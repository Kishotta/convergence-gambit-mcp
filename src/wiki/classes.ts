/**
 * create_class and create_subclass. Neither kind has a template, so each
 * article is written whole, in one request.
 *
 * A class, in 5.5e / Classes, has the Barbarian's shape:
 *
 *   infobox   the class image, then its core traits as key/value rows
 *             (Primary Ability, Hit Point Die, saves, skills, weapons,
 *             tools, armor, starting equipment), floated right
 *   intro     what the class is
 *   features  "### <Class> Class Features", the standard sentence, the
 *             features table, then a "#### Level N: Feature" section each
 *   Spell List  a second tab for a spellcaster: a collection of every
 *             article tagged both "Spell" and the class's name, which is
 *             how create_spell's class tags reach it
 *
 * A subclass is homed under its class, shaped like Great Old One: an
 * italic tagline quote, the image, the intro, then its features.
 *
 * Caster progression is a tag pair, as the existing articles have it:
 * "Spellcaster" plus "Full Caster", "Half Caster", "Third Caster" or
 * "Pact Caster".
 */

import type { Block, LegendKeeperClient, PropertyBlock, ResourceListItem } from "../lk/types";
import { composeBlocks, composeRuns } from "./compose";
import {
    createWhole,
    fetchImage,
    findByName,
    findHome,
    heading,
    line,
    refuseTwin,
    RULES_ROOT,
    uniqueTags,
    type Created,
    type StoredImage,
} from "./create";
import type { ResourceIndex } from "./index";

const HOME_FOLDER = "Classes";
const CLASS_TAG = "Class";
const SUBCLASS_TAG = "Subclass";

export const CASTERS = {
    none: undefined,
    full: "Full Caster",
    half: "Half Caster",
    third: "Third Caster",
    pact: "Pact Caster",
} as const;
export type Caster = keyof typeof CASTERS;

function casterTags(caster: Caster): string[] {
    const progression = CASTERS[caster];
    return progression ? ["Spellcaster", progression] : [];
}

export interface ClassInput {
    name: string;
    source: string;
    primaryAbility: string;
    hitPointDie: string;
    savingThrows: string;
    skillProficiencies: string;
    weaponProficiencies: string;
    toolProficiencies?: string;
    armorTraining: string;
    startingEquipment: string;
    caster: Caster;
    /** Default: a spellcaster gets one. */
    spellList?: boolean;
    description: string;
    featuresTable: string;
    features: string;
    tags: string[];
    imageUrl?: string;
    hidden: boolean;
    parentId?: string;
}

export async function createClass(lk: LegendKeeperClient, index: ResourceIndex, input: ClassInput): Promise<Created> {
    const name = input.name.trim();
    const parent = findHome(index, HOME_FOLDER, input.parentId);
    refuseTwin(index, "class", name, parent, CLASS_TAG);

    const table = composeBlocks(input.featuresTable);
    if (!table.some((block) => block.kind === "table")) {
        throw new Error(
            "featuresTable must be a markdown pipe table (| Level | PB | Class Features | … |). Nothing was created.",
        );
    }
    const image = input.imageUrl ? await fetchImage(input.imageUrl) : undefined;
    const spellList = input.spellList ?? input.caster !== "none";

    const created = await createWhole(lk, {
        name,
        parent,
        tags: uniqueTags([CLASS_TAG, name, input.source, ...casterTags(input.caster), ...input.tags]),
        hidden: input.hidden,
        image,
        imageFolder: HOME_FOLDER,
        documents: (stored) => [
            {
                name: "Main",
                blocks: [
                    classInfobox(input, stored),
                    ...composeBlocks(input.description),
                    heading(1, `${name} Class Features`),
                    line(
                        `As a ${name}, you gain the following class features when you reach the specified ${name} ` +
                            `levels. These features are listed in the ${name} Features table.`,
                    ),
                    ...table,
                    ...composeBlocks(input.features),
                ],
            },
            ...(spellList ? [{ name: "Spell List", blocks: [spellCollection(name)] }] : []),
        ],
    });
    return created;
}

function classInfobox(input: ClassInput, image?: StoredImage): Block {
    const traits: [string, string | undefined][] = [
        ["Primary Ability", input.primaryAbility],
        ["Hit Point Die", input.hitPointDie],
        ["Saving Throw Proficiencies", input.savingThrows],
        ["Skill Proficiencies", input.skillProficiencies],
        ["Weapon Proficiencies", input.weaponProficiencies],
        ["Tool Proficiencies", input.toolProficiencies],
        ["Armor Training", input.armorTraining],
        ["Starting Equipment", input.startingEquipment],
    ];
    const rows: PropertyBlock[] = [
        ...(image
            ? [{ kind: "image" as const, url: image.url, alt: image.alt, title: "Image", isTitleHidden: true, fill: true }]
            : []),
        {
            kind: "keyValue",
            title: "PROPERTIES",
            isTitleHidden: true,
            display: "list",
            rows: traits
                .filter((trait): trait is [string, string] => !!trait[1]?.trim())
                .map(([key, value]) => ({ key, content: composeRuns(value.trim()) })),
        },
    ];
    return { kind: "infobox", layout: "wrapRight", width: 40, rows };
}

/** Every spell tagged with the class: the class's own spell list, kept current by tags. */
function spellCollection(className: string): Block {
    return {
        kind: "resourceCollection",
        filter: { type: "filter", id: newId(), filterType: "tag", operator: "has_all", tags: ["Spell", className] },
    };
}

/** A fresh id in the API's form: a lowercase letter, then seven lowercase letters or digits. */
function newId(): string {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return [...bytes].map((b, i) => alphabet[b % (i === 0 ? 26 : alphabet.length)]).join("");
}

// ---------------------------------------------------------------------------
// Subclasses
// ---------------------------------------------------------------------------

export interface SubclassInput {
    name: string;
    /** The class's name or resource id. */
    parentClass: string;
    source: string;
    caster: Caster;
    tagline?: string;
    description: string;
    features: string;
    tags: string[];
    imageUrl?: string;
    hidden: boolean;
}

export async function createSubclass(
    lk: LegendKeeperClient,
    index: ResourceIndex,
    input: SubclassInput,
): Promise<Created> {
    const name = input.name.trim();
    const parent = findClass(index, input.parentClass);
    refuseTwin(index, `${parent.name} subclass`, name, parent);

    const image = input.imageUrl ? await fetchImage(input.imageUrl) : undefined;
    const tagline = input.tagline?.trim().replace(/^[*_]+|[*_]+$/g, "");

    return createWhole(lk, {
        name,
        parent,
        tags: uniqueTags([SUBCLASS_TAG, parent.name, input.source, ...casterTags(input.caster), ...input.tags]),
        hidden: input.hidden,
        image,
        imageFolder: HOME_FOLDER,
        documents: (stored) => [
            {
                name: "Main",
                blocks: [
                    ...(tagline
                        ? [{ kind: "quote", children: [{ kind: "paragraph", content: composeRuns(tagline, { italic: true }) }] } as Block]
                        : []),
                    ...(stored
                        ? [{ kind: "image", url: stored.url, alt: stored.alt, title: "Image", isTitleHidden: true, layout: "wrapRight", width: 40 } as Block]
                        : []),
                    ...composeBlocks(input.description),
                    ...composeBlocks(input.features),
                ],
            },
        ],
    });
}

/** The class article, by id or by name: anything in the Classes folder or tagged "Class". */
function findClass(index: ResourceIndex, wanted: string): ResourceListItem {
    const byId = index.get(wanted.trim());
    if (byId && !index.isTemplate(byId.id)) return byId;

    const root = index.children(null).find((r) => r.name === RULES_ROOT);
    const folder = root && index.children(root.id).find((r) => r.name === HOME_FOLDER);
    const classes = [...(folder ? index.children(folder.id) : []), ...index.withTags([CLASS_TAG], "all")];
    const found = findByName(classes, wanted);
    if (!found) {
        const known = [...new Set(classes.map((c) => c.name))].join(", ") || "none";
        throw new Error(
            `No class named "${wanted}" (classes: ${known}). Create the class first with create_class. Nothing was created.`,
        );
    }
    return found;
}
