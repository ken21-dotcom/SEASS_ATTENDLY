<?php
declare(strict_types=1);

header('Content-Type: application/json');
$path = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
if ($path === '/health') {
    echo json_encode(['status' => 'ok', 'dpi' => 512, 'threshold' => 40], JSON_THROW_ON_ERROR);
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
if ($path === '/template') {
    echo json_encode(['template' => $template], JSON_THROW_ON_ERROR);
    return;
}
if ($path === '/identify') {
    $candidates = is_array($body['candidates'] ?? null) ? $body['candidates'] : [];
    foreach ($candidates as $candidate) {
        $id = (int) ($candidate['id'] ?? 0);
        $templates = is_array($candidate['templates'] ?? null) ? array_values($candidate['templates']) : [];
        $fingers = is_array($candidate['fingers'] ?? null) ? array_values($candidate['fingers']) : [];
        foreach ($templates as $index => $candidateTemplate) {
            if ($candidateTemplate === $template) {
                echo json_encode([
                    'match' => [
                        'id' => $id,
                        'score' => 100.0,
                        'finger' => is_string($fingers[$index] ?? null) ? $fingers[$index] : null,
                    ],
                    'bestScore' => 100.0,
                    'threshold' => 40.0,
                ], JSON_THROW_ON_ERROR);
                return;
            }
        }
    }
    echo json_encode(['match' => null, 'bestScore' => 0.0, 'threshold' => 40.0], JSON_THROW_ON_ERROR);
    return;
}
http_response_code(404);
echo json_encode(['error' => 'not found'], JSON_THROW_ON_ERROR);
