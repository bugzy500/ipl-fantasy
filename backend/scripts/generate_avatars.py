#!/usr/bin/env python3
"""
Generate unique cartoon cricket avatars for each SPL league member.
Uses FreePik API (Flux 2 Turbo for speed).
Each member gets a distinctive character with unique colors/features.
"""
import json, os, sys, base64, urllib.request, urllib.error, time

API_BASE = "https://api.freepik.com"
API_KEY = os.environ.get("FREEPIK_API_KEY", "")
OUT_DIR = os.path.join(os.path.dirname(__file__), "avatars")
os.makedirs(OUT_DIR, exist_ok=True)

# Each member gets unique visual traits for their cartoon character
MEMBERS = [
    {"id": "69cd79e9b47877d97038425c", "name": "IKCyas", "trait": "cool guy with sunglasses and spiky hair, blue jersey, confident smirk"},
    {"id": "69cd16a0a6c8d91f0b7c44ae", "name": "Shubham Sharma", "trait": "cheerful guy with curly hair, green jersey, thumbs up pose"},
    {"id": "69ce725ba581ac3cd041b056", "name": "Infinity Max", "trait": "robot mascot with glowing purple eyes, silver metallic body, holding a cricket bat, futuristic"},
    {"id": "69cd13b6a6c8d91f0b7c4434", "name": "Meet", "trait": "smart guy with glasses and neat hair, black jersey with gold trim, pointing finger like a boss"},
    {"id": "69ce733c5a821b31e37355e0", "name": "Nishant", "trait": "tall athletic guy with headband, orange jersey, bowling action pose"},
    {"id": "69cd1431a6c8d91f0b7c4464", "name": "Daddy Cool", "trait": "suave guy with slicked back hair and chain necklace, red jersey, arms crossed cool pose"},
    {"id": "69cd145da6c8d91f0b7c446c", "name": "Prashast", "trait": "energetic guy with beard, yellow jersey, celebrating with fist pump"},
    {"id": "69ce74fc3f70f26a3a11489e", "name": "Manu", "trait": "stocky powerful guy, maroon jersey, hitting a six with cricket bat"},
    {"id": "69ce753d3f70f26a3a1148b2", "name": "Jayesh sharma", "trait": "chill guy with cap worn backwards, teal jersey, peace sign pose"},
    {"id": "69cd23705ecde5bfcc914426", "name": "Navneet", "trait": "sharp-looking guy with trimmed beard, white jersey, wicketkeeper gloves catching a ball"},
    {"id": "69cd041da14ac508c92a5297", "name": "Arpit Garg", "trait": "tech nerd with laptop and cricket bat, navy blue jersey, thinking pose"},
    {"id": "69cd2b4a1b45394ca935d602", "name": "DSP", "trait": "muscular intimidating guy, dark green jersey, fast bowling action"},
    {"id": "69cd5d6d9a254a9f15592726", "name": "Rahul Sharma", "trait": "classic batsman stance, sky blue jersey, elegant cover drive pose"},
    {"id": "69ce30d02593ccb007a6633b", "name": "Mannu", "trait": "fun chubby guy with big smile, pink jersey, dancing celebration pose"},
]

BASE_PROMPT = (
    "Cartoon caricature of a cricket player, fun exaggerated proportions, "
    "big head small body chibi style, vibrant colors, white circular background, "
    "clean vector illustration style, no text, high quality, "
)


def generate_image(prompt, output_path):
    """Generate image via FreePik Flux 2 Pro."""
    headers = {
        "x-freepik-api-key": API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    data = json.dumps({
        "prompt": prompt,
        "num_images": 1,
        "image": {"size": "square_1_1"},
        "styling": {"style": "cartoon"},
    }).encode()

    req = urllib.request.Request(
        f"{API_BASE}/v1/ai/text-to-image",
        data=data, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())

        images = result.get("data", [])
        if images and images[0].get("base64"):
            os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
            with open(output_path, "wb") as f:
                f.write(base64.b64decode(images[0]["base64"]))
            size_kb = os.path.getsize(output_path) / 1024
            print(f"  OK: {output_path} ({size_kb:.0f} KB)")
            return True
        else:
            print(f"  WARN: No image in response for {output_path}")
            print(f"  Response keys: {list(result.keys())}")
            return False
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:200] if e.fp else ""
        print(f"  ERROR {e.code}: {body}")
        return False
    except Exception as ex:
        print(f"  ERROR: {ex}")
        return False


def main():
    if not API_KEY:
        print("ERROR: Set FREEPIK_API_KEY env var")
        sys.exit(1)

    print(f"Generating {len(MEMBERS)} cartoon cricket avatars...")
    print(f"Output: {OUT_DIR}\n")

    success = 0
    for i, m in enumerate(MEMBERS):
        name = m["name"]
        trait = m["trait"]
        out = os.path.join(OUT_DIR, f"{m['id']}.png")

        # Skip if already generated
        if os.path.exists(out) and os.path.getsize(out) > 1000:
            print(f"[{i+1}/{len(MEMBERS)}] {name} — already exists, skipping")
            success += 1
            continue

        prompt = f"{BASE_PROMPT}{trait}, name tag says '{name}'"
        print(f"[{i+1}/{len(MEMBERS)}] {name}...")

        if generate_image(prompt, out):
            success += 1

        # Small delay to avoid rate limiting
        time.sleep(1)

    print(f"\nDone: {success}/{len(MEMBERS)} avatars generated")

    # Create a mapping file for the scraper
    mapping = {m["id"]: m["name"] for m in MEMBERS}
    mapping_path = os.path.join(OUT_DIR, "mapping.json")
    with open(mapping_path, "w") as f:
        json.dump(mapping, f, indent=2)
    print(f"Mapping saved: {mapping_path}")


if __name__ == "__main__":
    main()
