<?php
declare(strict_types=1);

header('Content-Type: application/json');
$path = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
if ($path === '/health') {
    echo json_encode([
        'status' => 'ok',
        'dpi' => 512,
        'threshold' => 40,          // 1:N enrollment duplicate check
        'verifyThreshold' => 30,    // 1:1 kiosk verification
    ], JSON_THROW_ON_ERROR);
    return;
}
if (($_SERVER['HTTP_X_MATCHING_KEY'] ?? '') !== 'attendly-synthetic-test-key') {
    http_response_code(401);
    echo json_encode(['error' => 'unauthorized'], JSON_THROW_ON_ERROR);
    return;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed'], JSON_THROW_ON_ERROR);
    return;
}
$body = json_decode((string) file_get_contents('php://input'), true);
$image = is_array($body) && is_string($body['image'] ?? null) ? base64_decode($body['image'], true) : false;
if ($image === false || !str_starts_with($image, "\x89PNG\r\n\x1a\n")) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid synthetic PNG'], JSON_THROW_ON_ERROR);
    return;
}
$template = base64_encode(hash('sha256', $image, true));

/**
 * Synthetic exact-template match. The PHP /verify request sends its configured
 * 1:1 threshold, so echo it back for the kiosk debug details.
 *
 * @param array<int,array<string,mixed>> $candidates
 */
$matchCandidates = static function (array $candidates, float $threshold) use ($template): array {
    foreach ($candidates as $candidate) {
        $id = (int) ($candidate['id'] ?? 0);
        $templates = is_array($candidate['templates'] ?? null) ? array_values($candidate['templates']) : [];
        $fingers = is_array($candidate['fingers'] ?? null) ? array_values($candidate['fingers']) : [];
        foreach ($templates as $index => $candidateTemplate) {
            if ($candidateTemplate === $template) {
                return [
                    'match' => [
                        'id' => $id,
                        'score' => 100.0,
                        'finger' => is_string($fingers[$index] ?? null) ? $fingers[$index] : null,
                    ],
                    'bestScore' => 100.0,
                    'threshold' => $threshold,
                ];
            }
        }
    }
    return ['match' => null, 'bestScore' => 0.0, 'threshold' => $threshold];
};

if ($path === '/template') {
    echo json_encode(['template' => $template], JSON_THROW_ON_ERROR);
    return;
}
if ($path === '/identify') {
    $candidates = is_array($body['candidates'] ?? null) ? array_values($body['candidates']) : [];
    echo json_encode($matchCandidates($candidates, 40.0), JSON_THROW_ON_ERROR);
    return;
}
if ($path === '/verify') {
    $candidate = is_array($body['candidate'] ?? null) ? $body['candidate'] : null;
    $threshold = is_numeric($body['threshold'] ?? null)
        ? max(1.0, min(100.0, (float) $body['threshold']))
        : 30.0;
    echo json_encode($matchCandidates($candidate === null ? [] : [$candidate], $threshold), JSON_THROW_ON_ERROR);
    return;
}
http_response_code(404);
echo json_encode(['error' => 'not found'], JSON_THROW_ON_ERROR);
