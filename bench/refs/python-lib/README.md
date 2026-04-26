# python-lib reference subset

Subset of [github.com/pandas-dev/pandas](https://github.com/pandas-dev/pandas) at commit
`be0642f7cb8900282a43b53cd50cf00a05161ed6`, included for benchmark reproducibility.

30 Python source files sampled from `pandas/core/` covering:
accessor helpers, array algorithms, array types (boolean, floating, integer,
numeric, period, masked, numpy, arrow), numba kernels, and sparse array support.

No test files are included. Files under `tests/` were excluded.

## License notice

The files in `pandas/` are copyright the pandas development team and contributors,
licensed under the BSD 3-Clause License. See
https://github.com/pandas-dev/pandas/blob/main/LICENSE for the full text.
These files are included here solely for benchmark reproducibility under the
BSD 3-Clause License terms.
