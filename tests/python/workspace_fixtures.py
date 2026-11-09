"""Synthetic workspace bundles for tests. Source URLs point at real authorities' domains, but every quote below is
ILLUSTRATIVE TEST TEXT written for FieldKit's tests, not a quotation of any regulation or document."""
import copy

NOW = "2026-11-10T00:00:00Z"

DAIRY_WORKFLOW = {
    "id": "milk-collection-check", "version": 1, "title": {"en": "Milk collection check", "hi": "दूध संग्रह जाँच"},
    "description": {"en": "Check each farmer's milk at the collection centre.", "hi": "संग्रह केंद्र पर हर किसान के दूध की जाँच।"},
    "domain": "dairy", "languages": ["en", "hi"], "default_language": "en",
    "fields": [
        {"id": "farmer_code", "type": "text", "label": {"en": "Farmer code", "hi": "किसान कोड"}, "required": True},
        {"id": "milk_type", "type": "single_choice", "label": {"en": "Milk", "hi": "दूध"}, "required": True,
         "options": [{"value": "cow", "label": {"en": "Cow", "hi": "गाय"}}, {"value": "buffalo", "label": {"en": "Buffalo", "hi": "भैंस"}}]},
        {"id": "fat_pct", "type": "number", "label": {"en": "Fat (%)", "hi": "वसा (%)"}, "unit": "%", "required": True},
        {"id": "snf_pct", "type": "number", "label": {"en": "SNF (%)", "hi": "SNF (%)"}, "unit": "%", "required": True},
        {"id": "smell_ok", "type": "checkbox", "label": {"en": "Smell and colour normal", "hi": "गंध और रंग सामान्य"}},
    ],
    "classification": {"rules": [
        {"id": "snf_low", "label": {"en": "SNF below the minimum", "hi": "SNF न्यूनतम से कम"}, "severity": "medium",
         "when": {"op": "lt", "field": "snf_pct", "value": 8.5}, "evidence_ids": ["ev_snf_cow"]}]},
}

BUNDLE = {
    "id": "dairy-collection-mh", "title": {"en": "Dairy collection QA (Maharashtra)", "hi": "दुग्ध संग्रह गुणवत्ता (महाराष्ट्र)"},
    "profile": {
        "role": "Milk collection centre quality checker", "industry": "dairy", "country": "IN", "region": "Maharashtra",
        "responsibilities": [
            {"id": "r_accept", "description": "Accept or reject each farmer's milk at collection", "frequency": "twice daily",
             "decisions": ["accept", "reject", "re-test"]},
            {"id": "r_adulteration", "description": "Spot possible adulteration", "decisions": ["send sample to lab"]}],
        "tools_and_instruments": [{"name": "Milk analyser", "units": ["%"]}, {"name": "Lactometer"}],
        "procedures_in_use": [{"title": "Centre SOP v3", "source": "user_document"}],
    },
    "languages": {"content": ["en", "hi"], "speech": ["en", "hi"], "ocr": ["en", "hi"]},
    "workflows": [DAIRY_WORKFLOW],
    "sources": [
        {"id": "s_fssai", "url": "https://www.fssai.gov.in/upload/uploadfiles/files/Dairy_Regulations.pdf", "title": "Dairy standards",
         "publisher": "FSSAI", "type": "regulator", "retrieved_at": NOW},
        {"id": "s_nddb", "url": "https://www.nddb.coop/information/milk-testing", "title": "Milk testing", "publisher": "NDDB",
         "type": "extension_or_ngo", "retrieved_at": NOW},
        {"id": "s_icar", "url": "https://icar.org.in/dairy-quality", "title": "Dairy quality", "publisher": "ICAR",
         "type": "academic", "retrieved_at": NOW},
        {"id": "s_forum", "url": "https://www.reddit.com/r/dairy/comments/x", "title": "Forum thread", "publisher": "reddit",
         "type": "government", "retrieved_at": NOW},
        {"id": "s_fake_gov", "url": "https://milk-rules-blog.example.com/fssai", "title": "FSSAI explained", "publisher": "blog",
         "type": "government", "retrieved_at": NOW},
        {"id": "s_sop", "url": "", "title": "Centre SOP v3", "publisher": "the user's dairy", "type": "user_document", "retrieved_at": NOW},
    ],
    "evidence": [
        {"id": "ev_snf_cow", "claim": "Cow milk below 8.5% SNF does not meet the standard",
         "excerpts": [{"source_id": "s_fssai", "quote": "ILLUSTRATIVE TEST TEXT: cow milk minimum SNF 8.5 percent", "locator": "test p.1"}],
         "applicability": {"jurisdiction": "IN", "matches_profile": True}},
        {"id": "ev_two_t2", "claim": "Re-test before rejecting a borderline sample",
         "excerpts": [{"source_id": "s_nddb", "quote": "ILLUSTRATIVE TEST TEXT: re-test borderline samples once"},
                      {"source_id": "s_icar", "quote": "ILLUSTRATIVE TEST TEXT: repeat the test for borderline results"}],
         "applicability": {"matches_profile": True}},
        {"id": "ev_single_t2", "claim": "Clean the analyser daily",
         "excerpts": [{"source_id": "s_nddb", "quote": "ILLUSTRATIVE TEST TEXT: clean analysers every day"}],
         "applicability": {"matches_profile": True}},
        {"id": "ev_conflict", "claim": "Buffalo milk minimum fat",
         "excerpts": [{"source_id": "s_fssai", "quote": "ILLUSTRATIVE TEST TEXT: buffalo milk fat minimum A"}],
         "conflicts": [{"source_id": "s_icar", "claim": "ILLUSTRATIVE TEST TEXT: buffalo fat minimum B in this state"}],
         "applicability": {"matches_profile": True}},
        {"id": "ev_model_only", "claim": "Add baking soda to sour milk", "excerpts": [], "applicability": {"matches_profile": True}},
        {"id": "ev_forum", "claim": "Forum says reject below 8%",
         "excerpts": [{"source_id": "s_forum", "quote": "ILLUSTRATIVE TEST TEXT: we always reject below 8 percent"}],
         "applicability": {"matches_profile": True}},
        {"id": "ev_fake_gov", "claim": "Blog says SNF 8.5",
         "excerpts": [{"source_id": "s_fake_gov", "quote": "ILLUSTRATIVE TEST TEXT: blog restating SNF rules"}],
         "applicability": {"matches_profile": True}},
        {"id": "ev_sop", "claim": "Samples are kept for 24 hours", "user_procedure": True,
         "excerpts": [{"source_id": "s_sop", "quote": "ILLUSTRATIVE TEST TEXT: keep every sample for 24 hours"}],
         "applicability": {"matches_profile": True}},
        {"id": "ev_wrong_place", "claim": "National rule applied to another state",
         "excerpts": [{"source_id": "s_fssai", "quote": "ILLUSTRATIVE TEST TEXT: rule for a different state"}],
         "applicability": {"matches_profile": False, "notes": "other state"}},
    ],
    "knowledge": {"entries": [
        {"id": "k_retest", "type": "procedure", "title": {"en": "Re-test a borderline sample", "hi": "सीमा पर नमूने की दोबारा जाँच"},
         "text": {"en": "Mix the sample and test again once.", "hi": "नमूना मिलाएँ और एक बार फिर जाँचें।"}, "evidence_ids": ["ev_two_t2"]},
        {"id": "k_background", "type": "explanation", "title": {"en": "What SNF means", "hi": "SNF क्या है"},
         "text": {"en": "Solids other than fat.", "hi": "वसा के अलावा ठोस पदार्थ।"}, "evidence_ids": []},
    ]},
    "vocabulary": {"entries": [{"term": "SNF", "lang": "en", "definition": "Solids-not-fat", "translations": {"hi": "वसा-रहित ठोस"}}]},
    "report_policy": {"decision_scale": [
        {"id": "reject", "label": {"en": "Reject", "hi": "अस्वीकार"}, "severity": "high"},
        {"id": "retest", "label": {"en": "Re-test", "hi": "दोबारा जाँच"}, "severity": "medium"},
        {"id": "accept", "label": {"en": "Accept", "hi": "स्वीकार"}, "severity": "low"}]},
    "guides": [{
        "id": "g_accept", "title": {"en": "Accept or reject milk", "hi": "दूध स्वीकार या अस्वीकार"}, "workflow_id": "milk-collection-check",
        "start": "n_snf", "evidence_ids": [],
        "nodes": {
            "n_snf": {"slot": "snf_pct", "field": "snf_pct",
                      "next": [{"when": {"op": "lt", "field": "snf_pct", "value": 8.5}, "to": "n_retested"}], "default": "o_accept"},
            "n_retested": {"slot": "retested", "question": {"en": "Was it re-tested?", "hi": "क्या दोबारा जाँचा गया?"}, "input": "yes_no",
                           "next": [{"when": {"op": "eq", "field": "retested", "value": True}, "to": "o_reject"}], "default": "o_retest"},
            "o_retest": {"outcome": {"decision": "retest", "title": {"en": "Re-test once", "hi": "एक बार दोबारा जाँचें"},
                                     "actions": [{"text": {"en": "Mix and re-test", "hi": "मिलाकर दोबारा जाँचें"}, "evidence_ids": ["ev_two_t2"]}]}},
            "o_reject": {"outcome": {"decision": "reject", "title": {"en": "Reject", "hi": "अस्वीकार करें"},
                                     "actions": [{"text": {"en": "Reject and record the reason", "hi": "अस्वीकार करें और कारण लिखें"},
                                                  "evidence_ids": ["ev_snf_cow"]},
                                                 {"kind": "escalate", "text": {"en": "Tell the centre manager", "hi": "केंद्र प्रबंधक को बताएँ"}}]}},
            "o_accept": {"outcome": {"decision": "accept", "title": {"en": "Accept", "hi": "स्वीकार करें"},
                                     "actions": [{"text": {"en": "Accept the milk", "hi": "दूध स्वीकार करें"}, "evidence_ids": ["ev_snf_cow"]}]}},
        }}],
    "gaps": [{"topic": "Ammonium sulphate limit", "searched": ["FSSAI dairy regulations"], "note": "No limit found in the regulations."}],
    "traceability": [{"responsibility_id": "r_accept", "workflow_ids": ["milk-collection-check"], "guide_ids": ["g_accept"]},
                     {"responsibility_id": "r_adulteration", "entry_ids": ["k_retest"]}],
}


def bundle(**changes):
    b = copy.deepcopy(BUNDLE)
    b.update(changes)
    return b
