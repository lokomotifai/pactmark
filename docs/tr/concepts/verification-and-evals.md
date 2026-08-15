---
title: Verification ve eval
description: Exact artifact üzerindeki doğrulamayı probabilistic değerlendirmeden ayırın.
---

> Compatibility: Pactmark 0.2.x.

## Doğrulama

`Verifier`, exact Artifact digest için sürümlü `VerificationResult` üretir. Schema,
checksum ve deterministic custom checks model key gerektirmez.

## Eval

Model-assisted eval aynı model credential, budget ve data-export sınırlarına tabidir.
Rubric, model identity ve sınırlamalar kayıt altına alınır.

## Sınır

Başarılı VerificationResult artifact'ın evrensel olarak doğru olduğunu kanıtlamaz.
Exception yalnız exception-eligible bulguya uygulanabilir; security control'ü kaldıramaz.
