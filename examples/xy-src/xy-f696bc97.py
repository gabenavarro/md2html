import numpy as np
import xy

rng = np.random.default_rng(42)
days = np.arange(1, 92)
base = 210 + 130 * (1 - np.exp(-days / 28))
noise = rng.normal(0, 14, days.size)
throughput = np.clip(base + noise, 150, 420)

chart = xy.line_chart(
    xy.line(days, throughput, color="#4f46e5", width=2.5),
    xy.x_axis(label="Days since run start"),
    xy.y_axis(label="sequences / s"),
    title="Validation throughput",
)
