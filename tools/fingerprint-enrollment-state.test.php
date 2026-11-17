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
function namedEntries(int $number): array
{
    $fingers = [
        'left-thumb', 'left-index', 'left-middle', 'left-ring', 'left-little',
        'right-thumb', 'right-index', 'right-middle', 'right-ring', 'right-little',
    ];
    $entries = [];
    foreach (array_slice($fingers, 0, $number) as $finger) {
        $entries[] = ['finger' => $finger, 'templates' => [base64_encode('synthetic-template-' . $finger)]];
    }
    return $entries;
}
function encoded(array $entries): string
{
    return json_encode($entries, JSON_THROW_ON_ERROR);
}

fwrite(STDOUT, "fingerprint-enrollment-state.test.php\n");
$partial = $decode->invoke($repo, encoded(namedEntries(9)));
check('9 of 10 named fingers remains incomplete', count($count->invoke($repo, $partial)) === 9);
$full = $decode->invoke($repo, encoded(namedEntries(10)));
check('10 named fingers is complete', count($count->invoke($repo, $full)) === 10);

$replacement = ['left-thumb' => [base64_encode('synthetic-template-left-thumb-redone')]];
$updated = $replace->invoke($repo, $full, 'left-thumb', $replacement['left-thumb']);
check('re-enrolling one finger keeps a full student at 10 of 10', count($count->invoke($repo, $updated)) === 10);
check('re-enrolling one finger replaces only that finger template',
    $updated[0]['templates'] === $replacement['left-thumb'] && count($updated) === 10);

$legacy = $decode->invoke($repo, json_encode([
    base64_encode('synthetic-legacy-template-a'),
    base64_encode('synthetic-legacy-template-b'),
], JSON_THROW_ON_ERROR));
check('legacy flat template arrays stay finger-unknown and count as incomplete',
    count($legacy) === 1 && $legacy[0]['finger'] === null && count($count->invoke($repo, $legacy)) === 0);

$legacyPlusOne = $replace->invoke($repo, $legacy, 'right-thumb', [base64_encode('synthetic-template-right-thumb')]);
check('legacy unknown templates are preserved when named fingers are added',
    count($legacyPlusOne) === 2 && count($count->invoke($repo, $legacyPlusOne)) === 1);

fwrite(STDOUT, "{$passed} enrollment state assertions passed.\n");
