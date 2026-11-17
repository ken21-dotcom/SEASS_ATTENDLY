<?php
/**
 * Fingerprint enrollment state tests.
 * Run: php tools/fingerprint-enrollment-state.test.php
 */
declare(strict_types=1);

require __DIR__ . '/../attendly-backend/src/Repository.php';

use Attendly\Repository;

$repoReflection = new ReflectionClass(Repository::class);
$repo = $repoReflection->newInstanceWithoutConstructor();
$decode = $repoReflection->getMethod('decodeFingerprintEntries');
$count = $repoReflection->getMethod('completedFingerprintFingers');
$replace = $repoReflection->getMethod('replaceFingerprintEntry');
$decode->setAccessible(true);
$count->setAccessible(true);
$replace->setAccessible(true);

$passed = 0;
function check(string $name, bool $condition): void
{
    global $passed;
    if (!$condition) {
        throw new RuntimeException('FAIL: ' . $name);
    }
    $passed++;
    fwrite(STDOUT, "  ok    {$name}\n");
}

/**
 * Each finger now stores two templates from two placements. The default is 2
 * so every completion assertion below also proves that a finger with two
 * templates still counts once, not twice.
 *
 * @return string[]
 */
function fingerTemplates(string $finger, int $templatesPerFinger = 2): array
{
    $templates = [];
    for ($index = 1; $index <= $templatesPerFinger; $index++) {
        $templates[] = base64_encode('synthetic-template-' . $finger . '-' . $index);
    }
    return $templates;
}

function namedEntries(int $number, int $templatesPerFinger = 2): array
{
    $fingers = [
        'left-thumb', 'left-index', 'left-middle', 'left-ring', 'left-little',
        'right-thumb', 'right-index', 'right-middle', 'right-ring', 'right-little',
    ];
    $entries = [];
    foreach (array_slice($fingers, 0, $number) as $finger) {
        $entries[] = [
            'finger' => $finger,
            'templates' => fingerTemplates($finger, $templatesPerFinger),
        ];
    }
    return $entries;
}

function encoded(array $entries): string
{
    return json_encode($entries, JSON_THROW_ON_ERROR);
}

function everyFingerHasTemplates(array $entries, int $expected): bool
{
    foreach ($entries as $entry) {
        if (count($entry['templates'] ?? []) !== $expected) {
            return false;
        }
    }
    return true;
}

fwrite(STDOUT, "fingerprint-enrollment-state.test.php\n");
$partial = $decode->invoke($repo, encoded(namedEntries(9)));
check('9 of 10 named fingers remains incomplete', count($count->invoke($repo, $partial)) === 9);
check('9 enrolled fingers keep two templates each', everyFingerHasTemplates($partial, 2));

$full = $decode->invoke($repo, encoded(namedEntries(10)));
check('10 fingers with 2 templates each count as 10 of 10', count($count->invoke($repo, $full)) === 10);
check('10/10 stores 20 templates, two per finger',
    count($full) === 10
    && everyFingerHasTemplates($full, 2)
    && array_sum(array_map(static fn(array $entry): int => count($entry['templates']), $full)) === 20);

$oneFinger = $decode->invoke($repo, encoded([
    ['finger' => 'left-thumb', 'templates' => fingerTemplates('left-thumb')],
]));
check('two templates for one finger count as one finger, not two',
    count($oneFinger) === 1 && count($count->invoke($repo, $oneFinger)) === 1);

$replacement = ['left-thumb' => fingerTemplates('left-thumb-redone')];
$updated = $replace->invoke($repo, $full, 'left-thumb', $replacement['left-thumb']);
check('re-enrolling one finger keeps a full student at 10 of 10', count($count->invoke($repo, $updated)) === 10);
check('re-enrolling one finger replaces both templates for only that finger',
    $updated[0]['templates'] === $replacement['left-thumb']
    && count($updated[0]['templates']) === 2
    && count($updated) === 10);

$legacy = $decode->invoke($repo, json_encode([
    base64_encode('synthetic-legacy-template-a'),
    base64_encode('synthetic-legacy-template-b'),
], JSON_THROW_ON_ERROR));
check('legacy flat template arrays stay finger-unknown and count as incomplete',
    count($legacy) === 1 && $legacy[0]['finger'] === null && count($count->invoke($repo, $legacy)) === 0);

$legacyPlusOne = $replace->invoke($repo, $legacy, 'right-thumb', fingerTemplates('right-thumb'));
check('legacy unknown templates are preserved when named fingers are added',
    count($legacyPlusOne) === 2 && count($count->invoke($repo, $legacyPlusOne)) === 1);
check('a newly named finger keeps both of its templates',
    count($legacyPlusOne[1]['templates']) === 2);

fwrite(STDOUT, "{$passed} enrollment state assertions passed.\n");
