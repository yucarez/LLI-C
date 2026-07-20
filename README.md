# LLI-C Software

Just a simulation right now, since we don't have the robot yet lol.

## Run it

```bash
cd LLI-C
pip install -r requirements.txt
python app.py
```

Then open **http://127.0.0.1:5000** in your browser.

## Project layout

```
efs3-simulator/
├── app.py                # All simulation logic + Flask routes
├── requirements.txt
├── templates/
│   └── index.html        # Static markup (Jinja for the scenario buttons only)
└── static/
    ├── style.css          # Visual styling (unchanged from the original design)
    └── app.js             # Thin renderer: polls /api/state, draws canvases
```
