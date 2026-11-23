<?php
function png_chunk(string $type, string $data): string {
    $payload = $type . $data;
    return pack('N', strlen($data)) . $payload . hash('crc32b', $payload, true);
}
function synthetic_fingerprint_image(int $seed): string {
    $width = 256;
    $height = 256;
    $scanlines = '';
    for ($y = 0; $y < $height; $y++) {
        $scanlines .= "\0";
        for ($x = 0; $x < $width; $x++) {
            $phase = ($y + 4.2 * sin(($x + $seed * 7) / 11) + 2.1 * sin(($x + $seed) / 23)) / 5.2;
            $ridge = (sin($phase) + 1) / 2;
            $scanlines .= chr($ridge > 0.5 ? 28 : 238);
        }
    }
    $header = pack('NNCCCCC', $width, $height, 8, 0, 0, 0, 0);
    $png = "\x89PNG\r\n\x1a\n" . png_chunk('IHDR', $header)
        . png_chunk('IDAT', gzcompress($scanlines, 9)) . png_chunk('IEND', '');
    return base64_encode($png);
}

$b64 = synthetic_fingerprint_image(42);
$ch = curl_init('http://127.0.0.1:8090/template');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-Matching-Key: attendly-synthetic-test-key'],
    CURLOPT_POSTFIELDS => json_encode(['image' => $b64])
]);
$res = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
echo "HTTP: $code\n$res\n";
