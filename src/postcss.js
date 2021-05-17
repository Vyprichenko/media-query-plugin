/**
 * The PostCSS plugin component is supposed to extract the media CSS from the source chunks.
 * The CSS get saved in the store.
 */

const postcss = require('postcss');
const store = require('./store');
const normalize = require('./utils/normalize');

const minWidthRegExp = /min\-width:([+-]?\d+)px/;
const maxWidthRegExp = /max\-width:([+-]?\d+)px/;

/**
 * Parses numeric minWidth and maxWidth values from media query string.
 * @param {string} query
 * @returns {Object}
 */
const getQueryBounds = (query) => {
    const nquery = normalize(query);
    const minWidth = +(minWidthRegExp.exec(nquery)?.[1] ?? undefined);
    const maxWidth = +(maxWidthRegExp.exec(nquery)?.[1] ?? undefined);

    if (minWidth > 0 || maxWidth > 0)
        return {
            minWidth: minWidth >= 0 ? minWidth : Number.NEGATIVE_INFINITY,
            maxWidth: maxWidth >= 0 ? maxWidth : Number.POSITIVE_INFINITY
        };
    else {
        return { minWidth, maxWidth };
    }
};

/**
 * Turns "empty" bounds into null.
 * @param {Object} bounds
 * @returns {(Object|null)}
 */
const nullBounds = (bounds) => {
    if (bounds.minWidth == bounds.maxWidth) return null;
    return bounds;
};

/**
 * Checks if bounds B completely includes bounds A.
 * @param {Object} boundsA
 * @param {number} boundsA.minWidth
 * @param {number} boundsA.maxWidth
 * @param {Object} boundsB
 * @param {number} boundsB.minWidth
 * @param {number} boundsB.maxWidth
 * @returns {boolean}
 */
const boundsIncluded = (
    { minWidth, maxWidth },
    { minWidth: boundsMinWidth, maxWidth: boundsMaxWidth }
) => minWidth >= boundsMinWidth && maxWidth <= boundsMaxWidth;

/**
 * Checks if bounds A and B intersects.
 * @param {Object} boundsA
 * @param {number} boundsA.minWidth
 * @param {number} boundsA.maxWidth
 * @param {Object} boundsB
 * @param {number} boundsB.minWidth
 * @param {number} boundsB.maxWidth
 * @returns {boolean}
 */
const boundsIntersects = (
    { minWidth: minWidthA, maxWidth: maxWidthA },
    { minWidth: minWidthB, maxWidth: maxWidthB }
) => {
    if (minWidthA <= minWidthB) {
        return maxWidthA > minWidthB;
    } else {
        return minWidthA < maxWidthB;
    }
};

/**
 * Subtracts boundsB from boundsA.
 * @param {Object} boundsA
 * @param {Object} boundsB
 * @returns {(Object|Object[]|null)}
 */
const subtractBounds = (boundsA, boundsB) => {
    if (Array.isArray(boundsA)) {
        return boundsA.flatMap((bounds) => subtractBounds(bounds, boundsB));
    }
    if (boundsA === null) return null;
    if (boundsB === null) return boundsA;
    if (boundsIncluded(boundsA, boundsB)) return null;
    if (boundsIncluded(boundsB, boundsA))
        return [
            { minWidth: boundsA.minWidth, maxWidth: boundsB.minWidth },
            { minWidth: boundsB.maxWidth, maxWidth: boundsA.maxWidth }
        ].map(nullBounds);

    if (boundsIntersects(boundsA, boundsB)) {
        if (boundsA.minWidth < boundsB.minWidth)
            return {
                minWidth: boundsA.minWidth,
                maxWidth: boundsB.minWidth
            };
        else
            return {
                minWidth: boundsB.maxWidth,
                maxWidth: boundsA.maxWidth
            };
    }
    return boundsA;
};

/**
 * Returns distance between bounds.minWidth and bounds.maxWidth,
 * if minWidth and maxBounds differs by 1, the distance is still 0.
 * @param {Object} bounds
 * @param {number} bounds.minWidth
 * @param {number} bounds.maxWidth
 * @returns {number}
 */
const getBoundsSize = ({ minWidth, maxWidth }) => {
    const x = maxWidth - minWidth;
    return x > 1 ? x - 1 : 0;
};

module.exports = postcss.plugin('MediaQueryPostCSS', (options) => {
    const queriesBounds = Object.keys(options.queries).reduce(
        (bounds, query) => {
            bounds[query] = getQueryBounds(query);
            return bounds;
        },
        {}
    );

    function addToStore(name, atRule) {
        const css = postcss.root().append(atRule).toString();
        const query = atRule.params;

        store.addMedia(name, css, options.path, query);
    }

    function getGroupName(name) {
        const groupNames = Object.keys(options.groups);

        for (let i = 0; i < groupNames.length; i++) {
            const groupName = groupNames[i];
            const group = options.groups[groupName];

            if (group instanceof RegExp) {
                if (name.match(group)) {
                    return groupName;
                }
            } else if (Array.isArray(group)) {
                if (group.includes(name)) {
                    return groupName;
                }
            }
        }
    }

    function getQueryNamesByBounds(queryBounds) {
        const queries = Object.keys(options.queries);
        return queries
            .filter((q) => boundsIntersects(queryBounds, queriesBounds[q]))
            .map((q) => [options.queries[q], q]);
    }

    function getQueryNamesByDefinition(query) {
        const queries = Object.keys(options.queries);
        return queries
            .filter((q) => normalize(q) === normalize(query))
            .map((q) => [options.queries[q], q]);
    }

    return (css, result) => {
        css.walkAtRules('media', (atRule) => {
            const ruleQueryBounds = getQueryBounds(atRule.params);
            const queryNames = [
                ...getQueryNamesByBounds(ruleQueryBounds),
                ...getQueryNamesByDefinition(atRule.params)
            ];

            // Processing queryNames, consistently copying them
            // into corresponding media-css files, then calculating
            // the remainder size. If query was included completely,
            // i.e. it has no remainder after splitting between some
            // media-css files, it can be removed from the souce css file.
            const boundsRemainderSize = queryNames
                .reduce(
                    (remainder, [queryName, query]) => {
                        const groupName = getGroupName(options.basename);
                        const name = groupName
                            ? `${groupName}-${queryName}`
                            : `${options.basename}-${queryName}`;

                        addToStore(name, atRule);

                        return subtractBounds(remainder, queriesBounds[query]);
                    },
                    [ruleQueryBounds]
                )
                .flat()
                .filter((bounds) => bounds)
                .reduce((size, bounds) => size + getBoundsSize(bounds), 0);

            if (queryNames.length > 0 && boundsRemainderSize == 0) {
                atRule.remove();
            }
        });
    };
});
